/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * A dummy version of node-vmadm that wraps index.dummy with calls to a
 * vminfod-like service that handles:
 *
 *  - events
 *  - loadVm
 *  - loadVms
 *
 * and adds a hook to ensure that all clients using this module see a consistent
 * view of the VMs on this CN.
 *
 */

var path = require('path');
var stream = require('stream');
var util = require('util');

var assert = require('assert-plus');
var restify = require('restify');
var watershed = require('watershed');

var diff = require('./diff');
var DummyVmadm = require('./index.dummy');

var ws = new watershed.Watershed();

// These fields aren't in the objects JSON that are written to disk, so we don't
// include them when comparing to determine whether the VM has changed or not.
var FIELDS_IGNORED_WHEN_COMPARING = [
    'boot_timestamp',
    'exit_status',
    'exit_timestamp',
    'last_modified',
    'pid',
    'zoneid',
    'zone_state'
];

function DummyVminfodVmadm(opts) {
    var self = this;

    DummyVmadm.call(self, opts);

    self.vminfodEventClient = restify.createClient({
        url: 'http://127.0.0.1:9090'
    });

    self.vminfodJsonClient = restify.createJsonClient({
        url: 'http://127.0.0.1:9090'
    });

}
util.inherits(DummyVminfodVmadm, DummyVmadm);

/*
 * Wrapper around `vmadm events -jr [uuid]`
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to watch, if unset all VMs are watched
 *      - name {String} Identifier string for debugging purposes, this will be
 *      used to construct the user-agent sent to vminfod
 * @param handler {Function} `function (ev)`
 *      - called when an event is seen
 * @param callback {Function} `function (err, obj)`
 *      - called when the stream is ready, or failed to start
 *      - err {Error} set if an error occured that means the stream cannot be
 *      created
 *      - stop {Function} function to stop the event stream
 * @return vs {VmadmCLIEventStream}
 *      - Can be used to listen for errors, ex: `vs.on('error', ...)`
 */
DummyVminfodVmadm.prototype.events =
function vmEvents(_opts, handler, callback) {
    var self = this;

    var opts;
    var shed;
    var stop = false;
    var wskey = ws.generateKey();

    opts = {
        agent: false,
        headers: {
            connection: 'upgrade',
            upgrade: 'websocket',
            'Sec-WebSocket-Key': wskey,
            'Sec-WebSocket-Version': '13',
            Server: self.serverUuid
        }
    };

    function getEvents() {
        self.log.debug({
            Server: self.serverUuid
        }, 'connecting to dummy vminfod');

        self.vminfodEventClient.get(opts,
            function _onGet(err, res) {

            if (err) {
                self.log.error({
                    err: err
                }, 'failed to get upgrade to dummy vminfod');
                callback(err);
                return;
            }

            res.once('upgradeResult',
                function _onUpgrade(upErr, upRes, upSocket, upHead) {

                if (upErr) {
                    self.log.error({
                        err: upErr
                    }, 'got error upgrade result from dummy vminfod');
                    callback(upErr);
                    return;
                }

                shed = ws.connect(upRes, upSocket, upHead, wskey);

                shed.on('text', function _onText(msg) {
                    var obj = JSON.parse(msg);

                    self.log.debug({
                        obj: obj,
                        Server: self.serverUuid
                    }, 'saw event from dummy vminfod');

                    if (obj.type !== 'info') {
                        handler(obj);
                    }
                });

                shed.on('end', function _onEnd() {
                    self.log.debug({
                        Server: self.serverUuid
                    }, 'dummy vminfod connection closed');

                    if (!stop) {
                        setImmediate(getEvents);
                    }
                });
            });
        });
    }

    getEvents();

    setImmediate(function _eventuallyCallCallback() {
        self._loadVmMap(function _onLoadVms(err, vms) {
            assert.ifError(err);

            callback(null, {
                ev: {
                    date: (new Date()).toISOString(),
                    type: 'ready',
                    vms: vms
                },
                stop: function _stop() {
                    stop = true;
                    if (shed) {
                        shed.end();
                        shed = undefined;
                    }
                }
            });
        });
    });

    return new VmadmCLIEventStream();
};


// --- validators

DummyVminfodVmadm.prototype._deleteValidator =
function _deleteValidator(uuid, callback) {
    var self = this;

    self._waitForVmobj({}, {
        timeout: 5000,
        uuid: uuid
    }, callback);
};

DummyVminfodVmadm.prototype._writeValidator =
function _writeValidator(vmobj, callback) {
    var self = this;

    self._waitForVmobj(vmobj, {
        timeout: 5000,
        uuid: vmobj.uuid
    }, callback);
};

// --- dummy helper methods

DummyVminfodVmadm.prototype._loadVm = function _loadVm(opts, callback) {
    assert.object(opts, 'opts');
    assert.uuid(opts.uuid, 'opts.uuid');

    var self = this;
    var url;
    var vmobj = {};

    url = path.join('/servers', self.serverUuid, 'vms', opts.uuid);

    self.vminfodJsonClient.get({
        agent: false,
        path: url
    }, function _onGet(err, req, res, obj) {
        var notFoundErr;

        self.log.trace({
            err: err,
            obj: obj
        }, 'loadVm response from dummy vminfod');

        if (!err) {
            vmobj = obj;
        } else if ([
            'ResourceNotFound',
            'VmNotFound'
        ].indexOf(err.restCode) !== -1) {
            // NOTE: destroy depends on this matching ': No such zone'
            notFoundErr = new Error('vmadm load ' + opts.uuid +
                ' failed: No such zone');
            notFoundErr.restCode = 'VmNotFound';

            callback(notFoundErr);
            return;
        }

        callback(err, vmobj);
    });
};

DummyVminfodVmadm.prototype._loadVms =
function loadVms(_opts, callback) {
    var self = this;
    var loadedVms = [];
    var url = path.join('/servers', self.serverUuid, 'vms');

    self.vminfodJsonClient.get(url, function _onGet(err, req, res, obj) {
        self.log.trace({
            err: err,
            obj: obj
        }, 'loadVms response from dummy vminfod');

        if (!err) {
            loadedVms = obj;
        }
        callback(err, loadedVms);
    });
};

DummyVminfodVmadm.prototype._waitForVmobj =
function _waitForVmobj(vmobj, opts, callback) {
    assert.object(opts, 'opts');
    assert.number(opts.timeout, 'opts.timeout');
    assert.uuid(opts.uuid, 'opts.uuid');

    var self = this;

    var alreadyDone = false;
    var stopEventWatcher;
    var timeoutHandle;

    function done(err) {
        if (!alreadyDone) {
            alreadyDone = true;
            clearTimeout(timeoutHandle);
            if (stopEventWatcher) {
                stopEventWatcher();
            }

            callback(err);
        } else {
            self.log.warn({
                stack: (new Error('')).stack
            }, 'already done _waitForVmobj.done() called again');
        }
    }

    function check(_vmobj) {
        var expectVmobj;
        var proposedVmobj;
        var vmdiff;

        expectVmobj = cleanVmobj(null, vmobj);
        proposedVmobj = cleanVmobj(expectVmobj, _vmobj);
        vmdiff = diff(expectVmobj, proposedVmobj);

        self.log.trace({
            diff: vmdiff,
            expectVmobj: expectVmobj,
            proposedVmobj: proposedVmobj,
            uuid: opts.uuid
        }, 'waitForVmobj checking for vmobj change');

        if (vmdiff.length === 0) {
            done();
        }
    }

    function tryLoading(cb) {
        // Now load the VM and check whether it already matches
        self._loadVm({uuid: opts.uuid}, function _onLoad(err, obj) {
            var loadedVmobj = {};

            if (err) {
                if (err.restCode === 'VmNotFound') {
                    self.log.trace('VM not found yet');
                } else {
                    self.log.warn({
                        err: err
                    }, 'Error in _loadVm');
                    cb(err);
                    return;
                }
            } else {
                loadedVmobj = obj;
            }

            self.log.debug({
                vmobj: loadedVmobj
            }, 'loaded VM');
            cb(null, loadedVmobj);
        });
    }

    // Set a timeout so we don't wait forever
    timeoutHandle = setTimeout(function _timeoutWait() {
        // one last load attempt.
        tryLoading(function _onLoad(loadErr, loadObj) {
            if (loadErr) {
                // Still failed...
                done(new Error('timeout waiting for VM change'));
                return;
            }
            check(loadObj);
        });
    }, opts.timeout);

    // Now watch for events so we catch if things change while or after we're
    // loading.
    self.events({
        }, function _onEvent(evt) {
            if (evt.vm) {
                self.log.info('saw VM event (create/modify)');
                check(evt.vm);
            } else if (evt.type === 'delete') {
                self.log.info('saw VM event (delete)');
                check({});
            } else {
                self.log.error({
                    evt: evt
                }, 'unknown event ' + evt.type);
            }
        }, function _onReady(err, obj) {
            if (err) {
                done(err);
                return;
            }

            assert.object(obj, 'obj');
            assert.func(obj.stop, 'obj.stop');
            stopEventWatcher = obj.stop;

            tryLoading(function _onLoad(loadErr, loadObj) {
                if (loadErr && loadErr.restCode !== 'VmNotFound') {
                    done(loadErr);
                    return;
                }
                check(loadObj);
            });
        }
    );

};

//
// Creates a new object using vmobj but removing any properties which have
// property names that don't exist in the object 'target' or which have been
// marked to be ignored when comparing. If 'target' is null, only properties
// in FIELDS_IGNORED_WHEN_COMPARING will be removed.
//
function cleanVmobj(target, vmobj) {
    var idx;
    var field;
    var keepFields;
    var newObj = {};

    keepFields = Object.keys(vmobj).filter(function _filterField(_field) {
        if (FIELDS_IGNORED_WHEN_COMPARING.indexOf(_field) !== -1) {
            return false;
        }

        if (!target || target.hasOwnProperty(_field)) {
            return true;
        }

        return false;
    });

    for (idx = 0; idx < keepFields.length; idx++) {
        field = keepFields[idx];
        newObj[field] = vmobj[field];
    }

    return (newObj);
}

// This implementation detail is now exposed as of TRITON-571 so we have to do
// this even though it makes no sense.
function VmadmCLIEventStream(_opts) {
}
util.inherits(VmadmCLIEventStream, stream.Transform);

module.exports = DummyVminfodVmadm;
