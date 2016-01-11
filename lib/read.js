var Juttle = require('juttle/lib/runtime').Juttle;
var JuttleErrors = require('juttle/lib/errors');
var JuttleMoment = require('juttle/lib/moment/juttle-moment');
var Promise = require('bluebird');
var google = require('googleapis');
var _ = require('underscore');
var Batchelor = require('batchelor');
var FilterGmailCompiler = require('./filter-gmail-compiler');

var auth;

var Read = Juttle.proc.source.extend({
    procName: 'read gmail',

    initialize: function(options, params, pname, location, program, juttle) {
        this.logger.debug('intitialize', options, params);
        this.gmail = google.gmail('v1');

        var time_related_options = ['from', 'to', 'last'];
        var allowed_options = time_related_options.concat(['raw']);
        var unknown = _.difference(_.keys(options), allowed_options);

        if (unknown.length > 0) {
            throw this.compile_error('RT-UNKNOWN-OPTION-ERROR',
                                     {proc: 'read gmail', option: unknown[0]});
        }

        // One of 'from', 'to', or 'last' must be present.
        var opts = _.intersection(_.keys(options), time_related_options);
        if (opts.length === 0) {
            throw this.compile_error('RT-MISSING-TIME-RANGE-ERROR');
        }

        // If 'from'/'to' are present, 'last' can not be present.
        if ((_.has(options, 'from') || _.has(options, 'to')) &&
            _.has(options, 'last')) {
            throw this.compile_error('RT-LAST-FROM-TO-ERROR');
        }

        // 'from' must be before 'to'
        if (_.has(options, 'from') && _.has(options, 'to') &&
            options.from > options.to) {
            throw this.compile_error('RT-TO-FROM-MOMENT-ERROR');
        }

        // If 'last' is specified, set appropriate 'from'/'to'
        if (_.has(options, 'last')) {
            this.from = program.now.subtract(options.last);
            this.to = program.now;
        } else {
            // Initialize from/to if necessary.
            this.from = options.from || program.now;
            this.to = options.to || program.now;
        }

        this.raw = options.raw;
        this.filter_search_expr = undefined;

        if (params.filter_ast) {
            this.logger.debug("Filter ast: ", params.filter_ast);
            var compiler = new FilterGmailCompiler({location: location});
            this.filter_search_expr = compiler.compile(params.filter_ast);
            this.logger.debug("Filter expression: ", this.filter_search_expr);
        }

        this.delay = options.delay || JuttleMoment.duration(1, 's');

        Promise.promisifyAll(this.gmail.users.messages);
    },

    start: function() {
        var self = this;

        return self.get_messages_for_timerange(self.from, self.to);
    },

    teardown: function() {
    },

    // Non juttle proc methods below here
    get_messages_for_timerange: function(from, to) {
        this.logger.debug('get_messages_for_timerange from=' + from + " to=" + to);
        var self = this;

        // Build a search expression given the options.
        var search = self.raw || "";

        if (this.filter_search_expr !== undefined) {
            search += " " + this.filter_search_expr;
        }

        var now = new JuttleMoment();

        // The gmail search expression only has per-day granularity,
        // so we quantize the -from and -to to the nearest day and do
        // additional filtering in get_messages().

        // XXX/mstemm not sure how the time zone is set. It's definitely not in UTC.
        search += " after:" + JuttleMoment.format(from, "YYYY/MM/DD", "US/Pacific");

        // Add 1 day to to and then quantize to a day. This
        // results in the next day, such that the before: date is
        // always in the future.
        if (! self.to.isEnd()) {
            search += " before:" + JuttleMoment.format(to.add(JuttleMoment.duration(1, "d")), "YYYY/MM/DD", "US/Pacific");
        }

        this.logger.debug("Search string:", search);
        return self.get_messages(from, to, search)
        .call("sort", function(a, b) {
            if (a.time.lt(b.time)) {
                return -1;
            } else if (a.time.eq(b.time)) {
                return 0;
            } else {
                return 1;
            }
        })
        .then(function(messages) {
            if (messages && messages.length > 0) {
                self.emit(messages);
            }
            return messages;
        })
        .then(function(messages) {
            // If to is in the future, arrange with the scheduler to
            // get all messages from the timestamp of the last message
            // to "to". Otherwise we're done.
            if (to.gt(now)) {
                var next_poll = now.add(self.delay);
                var next_from = from;

                if (messages && messages.length > 0) {
                    var last_time = _.last(messages).time;
                    next_from = last_time.add(JuttleMoment.duration(1, 'ms'));
                }

                self.program.scheduler.schedule(next_poll.unixms(), function() {
                    self.get_messages_for_timerange(next_from, to);
                });
            } else {
                self.eof();
            }
        })
        .catch(function(err) {
            self.logger.error("Could not read latest emails:", err);
        });
    },

    get_messages: function(from, to, search, pageToken) {
        var self = this;

        var opts = {
            auth: auth,
            userId: 'me',
            q: search
        };

        if (pageToken) {
            opts.pageToken = pageToken;
        }

        return self.gmail.users.messages.listAsync(opts)
        .then(function(response) {

            if (!_.has(response, "messages")) {
                return [];
            }

            self.logger.debug("Got " + response.messages.length + " potential messages");

            pageToken = response.nextPageToken;

            // Do a batch-fetch of all the message ids
            var batch = new Batchelor({
                'uri':'https://www.googleapis.com/batch',
                'method':'POST',
                'auth': {
                    'bearer': auth.credentials.access_token
                },
                'headers': {
                    'Content-Type': 'multipart/mixed'
                }
            });

            // The fields argument limits the fields returned to those
            // we are interested in.
            batch.add(_.map(response.messages, function(id) {
                return {
                    method: 'GET',
                    'path': '/gmail/v1/users/me/messages/' + id.id + "?fields=internalDate,id,snippet,payload/headers"
                };
            }));

            Promise.promisifyAll(batch);
            return batch.runAsync()
            .then(function(response) {
                return response.parts;
            });
        })
        .then(function(parts) {
            var messages = [];

            parts.forEach(function(part) {
                var message = part.body;
                var time = new JuttleMoment({rawDate: new Date(Number(message.internalDate))});

                if (time.lt(from)) {
                    return;
                }

                if (time.gt(to)) {
                    return;
                }

                var pt = {
                    time: time,
                    id: message.id,
                    snippet: message.snippet,
                    from: self.find_header(message, 'From'),
                    to: self.find_header(message, 'To'),
                    subject: self.find_header(message, 'Subject')
                };
                messages.push(pt);
            });

            if (pageToken) {
                return self.get_messages(from, to, search, pageToken).then(function(remaining_messages) {
                    return messages.concat(remaining_messages);
                });
            } else {
                return messages;
            }
        });
    },

    find_header: function(message, name) {
        var self = this;

        if (!_.has(message.payload, "headers")) {
            return "";
        }

        var match = _.find(message.payload.headers, function(header) {
            return (header.name === name);
        });

        if (match === undefined) {
            return "";
        } else {
            return match.value;
        }
    }

});

function init(provided_auth) {
    auth = provided_auth;
}

module.exports = {
    init: init,
    read: Read
};
