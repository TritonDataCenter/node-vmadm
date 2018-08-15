/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const stream = require('stream');
const util = require('util');

var assert = require('assert-plus');
const vasync = require('vasync');
const uuidv1 = require('uuid/v1');


/**
 * A dummy version of vmadm using json files on the local file system
 *
 * @param opts {Object} Options
 *      - serverUuid {String} The UUID of the dummy UUID.
 *      - serverRoot {String} The file system path for dummy json files for this
 *        server to live.
 *      - log {Bunyan} Bunyan logger
 */
function DummyVmadm(opts) {
    assert.object(opts);
    assert.uuid(opts.serverUuid, 'opts.serverUuid');
    assert.string(opts.serverRoot, 'opts.serverRoot');
    assert.object(opts.log, 'opts.log');

    this.serverUuid = opts.serverUuid;
    this.serverRoot = opts.serverRoot;
    this.log = opts.log;
}


// --- vmadm implementation

/**
 * Check whether a VM exists or not.
 *
 * @param opts {Object} Options
 *      - uuid {String} The VM uuid.
 *      - include_dni {Boolean} If true, return VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err, exists)`
 *      - err is set on unhandled error
 *      - otherwise; exists will be true or false
 */
DummyVmadm.prototype.exists = function vmExists(opts, callback) {
    const self = this;
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    this.load(opts, {fields: ['uuid']}, function _onLoad(err, vm) {
        if (err) {
            if (err.restCode === 'VmNotFound') {
                callback(null, false);
                return;
            }
            callback(err);
            return;
        }

        if (vm.do_not_inventory && !opts.include_dni) {
            /*
             * VM is marked do_not_inventory. And we don't have include_dni
             * option set indicating we want to include those, so we treat the
             * same as not existing.
             */
            self.log.trace(err, 'vmadm.exists(): ' + opts.uuid +
                ' has do_not_inventory');
            callback(null, false);
            return;
        }

        callback(null, true);
        return;
    });
};


/**
 * Call `vmadm get UUID`.
 *
 * @param opts {Object} Options
 *      - uuid {String} The VM uuid.
 * @param vmopts {Object} Optional vm options
 *      - fields {Array} Return only the keys give in `fields` array
 *      - include_dni {Boolean} If true, return VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */
DummyVmadm.prototype.load = function vmLoad(opts, vmopts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    if (!callback) {
        callback = vmopts;
    }

    this.log.trace({
        req_id: opts.req_id,
        uuid: opts.uuid
    }, 'loading VM');

    this._loadDummyVm({
        uuid: opts.uuid
    }, function _onVmLoad(err, vm) {
        var notFoundErr;

        if (err && err.code === 'ENOENT') {
            notFoundErr = new Error('vmadm load ' + opts.uuid +
                ' failed: No such zone');
            notFoundErr.restCode = 'VmNotFound';
            callback(notFoundErr);
            return;
        } else if (err) {
            callback(err);
            return;
        }

        if (vm.do_not_inventory && !opts.include_dni) {
            // Unless the caller is specifically asking for VMs that are
            // do_not_inventory, we treat them the same a VMs that don't exist.
            notFoundErr = new Error('vmadm load ' + opts.uuid +
                ' failed: No such zone');
            notFoundErr.restCode = 'VmNotFound';
            callback(notFoundErr);
            return;
        }

        if (opts.fields) {
            Object.keys(vm).forEach(function _removeUnwantedFields(field) {
                if (opts.fields.indexOf(field) === -1) {
                    // not a field we want
                    delete vm[field];
                }
            });
        }

        callback(null, vm);
        return;
    });
};


/**
 * Call `vmadm create`.
 *
 * @param opts {Object} Options
 * @param callback {Function} `function (err, info)`
 */
DummyVmadm.prototype.create = function vmCreate(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalString(opts.req_id, 'opts.req_id');

    const payload = opts;
    const req_id = opts.req_id;

    delete payload.log;
    delete payload.req_id;
    delete payload.sysinfo;
    delete payload.vmadmLogger;

    this.log.trace({
        req_id: req_id,
        payload: payload
    }, 'creating VM');

    assert.optionalUuid(payload.uuid, 'payload.uuid');
    if (!payload.hasOwnProperty('uuid')) {
        payload.uuid = uuidv1();
    }

    payload.state = 'running';
    payload.autoboot = true;
    payload.create_timestamp = (new Date()).toISOString();

    // TODO:
    //
    //   strip out properties we don't care about, validate ones we do.
    //   convert disks to final versions
    //   fill in other fields that happen in real vmadm
    //

    this._writeDummyVm(payload, {
    }, function _onWrite(err) {
        callback(err, {'uuid': payload.uuid});
    });
};


/**
 * Call `vmadm delete <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to delete
 *      - include_dni {Boolean} If true, delete VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */
DummyVmadm.prototype.delete = function vmDelete(opts, callback) {
    const self = this;
    assert.object(opts, 'opts');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var filename;
    var vmdir;

    vmdir = path.join(this.serverRoot, this.serverUuid, 'vms');

    this.log.trace({
        req_id: opts.req_id,
        uuid: opts.uuid
    }, 'deleting VM');

    assert.uuid(opts.uuid, 'opts.uuid');
    filename = path.join(vmdir, opts.uuid + '.json');

    // TODO: Checkk do_not_inventory
    vasync.pipeline({
        funcs: [
            // TODO: stop the instance, do any other cleanup
            function _unlinkFile(_, cb) {
                fs.unlink(filename, function _onUnlink(err) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    cb();
                });
            }
        ]
    }, function _onDeleted(err) {
        self.log.info({err: err, uuid: opts.uuid}, 'delete VM');
        callback(err);
    });
};


/**
 * Call `vmadm update`.
 *
 * @param opts {Object} VMADM update payload
 *      - log {Logger object}
 *      - include_dni {Boolean} If true, update VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */
DummyVmadm.prototype.update = function vmUpdate(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var log = opts.log;
    var payload = opts;
    var req_id = opts.req_id;

    delete payload.log;
    delete payload.req_id;
    delete payload.vmadmLogger;

    log.trace({
        payload: payload,
        req_id: req_id,
        uuid: opts.uuid
    }, 'updating VM');

    // TODO: this should actually update

    callback();
};



/**
 * Call `vmadm reboot <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to reboot
 *      - force {Boolean} Whether to force the reboot.
 *      - include_dni {Boolean} If true, reboot VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */
DummyVmadm.prototype.reboot = function vmReboot(opts, callback) {
    const self = this;
    assert.object(opts, 'opts');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var args = [];

    if (opts.force) {
        args.push('-F');
    }

    this.log.trace({
        args: args,
        force: Boolean(opts.force),
        req_id: opts.req_id,
        uuid: opts.uuid
    }, 'rebooting VM');

    // TODO: this should actually reboot

    // TODO: No sure how autoboot should be transfomed here?
    // TODO: What does -F actually do here?
    vasync.pipeline({funcs: [
        function stepShutdown(_, next) {
            self._updateDummyVmState({uuid: opts.uuid,
                                      state: 'shutting_down'},
                                     next);
        },
        function stepDown(_, next) {
            self._updateDummyVmState({uuid: opts.uuid,
                                      state: 'stopped'},
                                     next);
        },
        function stepBoot(_, next) {
            self._updateDummyVmState({uuid: opts.uuid,
                                      state: 'running', autoboot: true},
                                     next);
        }]}, function afterPipeline(err) {
            callback(err);
        });
};


/**
 * Call `vmadm lookup -j`.
 *
 * @param opts {Object} Options
 *      - uuid {String} The VM uuid.
 * @param vmopts {Object} Optional vm options
 *      - fields {Array} Return only the keys give in `fields` array
 *      - include_dni {Boolean} If true, return VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err, vms)`
 */
DummyVmadm.prototype.lookup = function vmLookup(search, opts, callback) {
    assert.object(search, 'search');
    assert.object(opts, 'opts');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    this.log.trace({
        req_id: opts.req_id,
        search: search
    }, 'lookup VMs');


    // XXX can't we also specify fields in opts?

    this._loadDummyVms({}, function _onLoadVms(err, loadedVms) {
        if (err) {
            callback(err);
            return;
        }

        if (JSON.stringify(search) === '{}') {
            // no search, just return all VMs
            callback(null, loadedVms);
            return;
        }

        assert.ok(false, 'Don\'t yet know how to handle search: ' +
            JSON.stringify(search));
    });
};


/**
 * Call `vmadm start <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to start
 *      - include_dni {Boolean} If true, start VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */
DummyVmadm.prototype.start = function vmStart(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    this.log.trace({
        req_id: opts.req_id,
        uuid: opts.uuid
    }, 'start VM');


    // TODO: this should actually do the start

    this._updateDummyVmState({uuid: opts.uuid,
                              state: 'running', autoboot: true},
                             callback);
};


/**
 * Call `vmadm stop <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to stop
 *      - force {Boolean} Whether to force the stop
 *      - include_dni {Boolean} If true, stop VMs that have do_not_inventory
 *        set. default: false.
 *      - timeout {Number} If set, timeout in seconds between sending SIGTERM
 *        and SIGKILL when stopping docker containers.
 * @param callback {Function} `function (err)`
 */
DummyVmadm.prototype.stop = function vmStop(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.optionalNumber(opts.timeout, 'opts.timeout');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    this.log.trace({
        req_id: opts.req_id,
        uuid: opts.uuid
    }, 'stop VM');

    // TODO: this should actually do the stop

    this._updateDummyVmState({uuid: opts.uuid,
                              state: 'stopped', autoboot: false},
                             callback);
};


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
DummyVmadm.prototype.events = function vmEvents(opts, handler, callback) {
    var self = this;
    assert.object(opts, 'opts');
    assert.optionalString(opts.uuid, 'opts.uuid');
    assert.optionalString(opts.name, 'opts.name');

    var vmdir = path.join(this.serverRoot, this.serverUuid, 'vms');

    self.fileWatches = {};
    self.loadingVms = {};

    // load initial set of files so we know when things change
    fs.readdir(vmdir, function _onReadDir(_err, files) {
        var filename;
        var idx;
        var modifyHandler;

        // XXX what to do on error

        self.instanceFiles = files;

        for (idx = 0; idx < files.length; idx++) {
            filename = files[idx];

            if (!zoneFromFilename(filename)) {
                self.log.warn('ignoring non-vm: ' + filename);
                continue;
            }

            // need to make a closure with a copy of the filename since
            // node doesn't give it to us w/ the event.
            modifyHandler = wrapHandler(filename, function _onModify(_evt, fn) {
                fs.exists(path.join(vmdir, fn), function _onExists(exists) {
                    if (exists) {
                        self._dispatchEvent('modify', zoneFromFilename(fn),
                            {}, handler);
                    } else {
                        self.log.debug('ignoring modify event for deleted '
                                       + 'file: ' + fn);
                    }
                });
            });

            self.fileWatches[filename] =
                fs.watch(path.join(vmdir, filename), {}, modifyHandler);
        }
    });

    self.fileWatches[vmdir] =
    fs.watch(vmdir, {}, function _onDirEvent(_evt) {
        fs.readdir(vmdir, function _onRead(err, files) {
            if (err) {
                callback(err);
            }
            var filename;
            var idx;
            var modifyHandler;

            // filter out temporary files from atomicRename
            const vmFiles = files.filter(function onFile(fname) {
                return fname.endsWith('.json');
            });

            // XXX this is a pretty inefficient way to generate the
            // added/deleted

            for (idx = 0; idx < vmFiles.length; idx++) {
                filename = vmFiles[idx];

                if (!zoneFromFilename(filename)) {
                    self.log.warn('ignoring non-vm: ' + filename);
                    continue;
                }

                if (self.instanceFiles.indexOf(filename) === -1) {
                    // didn't exist before, exists now: added
                    assert.equal(self.fileWatches[filename], undefined,
                        'file should not already have a watcher');

                    // need to make a closure with a copy of the filename since
                    // node doesn't give it to us w/ the event.
                    modifyHandler = wrapHandler(filename,
                        function _onModify(_, fn) {

                        fs.exists(path.join(vmdir, fn),
                            function _onExists(exists) {

                            if (exists) {
                                self._dispatchEvent('modify',
                                    zoneFromFilename(fn),
                                    {sysinfo: opts.sysinfo}, handler);
                            } else {
                                self.log.debug('ignoring modify event for '
                                    + 'deleted file: ' + fn);
                            }
                        });
                    });

                    self.fileWatches[filename] =
                        fs.watch(path.join(vmdir, filename), {},
                            modifyHandler);

                    self._dispatchEvent('create', zoneFromFilename(filename),
                        {sysinfo: opts.sysinfo}, handler);
                }
            }

            for (idx = 0; idx < self.instanceFiles.length; idx++) {
                filename = self.instanceFiles[idx];
                if (vmFiles.indexOf(filename) === -1) {
                    // existed before, doesn't exist now: deleted
                    if (self.fileWatches[filename]) {
                        self.fileWatches[filename].close();
                        delete self.fileWatches[filename];
                    }
                    self._dispatchEvent('delete', zoneFromFilename(filename),
                        {}, handler);
                }
            }

            // replace with new list
            self.instanceFiles = vmFiles;
        });
    });


    // We do this with setImmediate because the node-vmadm callers depend on
    // getting the return value and using it before the callback runs.
    setImmediate(function _eventuallyCallCallback() {
        callback(null, {
            ev: {
                date: (new Date()).toISOString(),
                type: 'ready',
                vms: { 'uuid': {
                    // uuid: ?
                }
                     }
            },
            stop: function _stop() {
                self._deleteAllWatchers();
            }
        });

        return new VmadmCLIEventStream({});
    });
};


// --- dummy helper methods

// TODO: By deleting *all* watchers, we prevent multiple concurrent uses of
// events().  Is that actually used?
DummyVmadm.prototype._deleteAllWatchers = function _deleteAllWatchers() {
    var self = this;
    var filename;
    var idx;
    var keys;

    keys = Object.keys(self.fileWatches);
    for (idx = 0; idx < keys.length; idx++) {
        filename = keys[idx];

        self.log.debug('DELETE WATCH: ' + filename);

        self.fileWatches[filename].close();
        delete self.fileWatches[filename];
    }
};


DummyVmadm.prototype._dispatchEvent =
function _dispatchEvent(evtName, zonename, opts, handler) {
    var self = this;
    assert.string(evtName, 'evtName');
    assert.uuid(zonename, 'zonename');
    assert.object(opts, 'opts');
    assert.func(handler, 'handler');

    if (self.loadingVms[zonename]) {
        self.log.debug('skipping ' + zonename
            + ' which is already being loaded');
        return;
    }
    self.loadingVms[zonename] = (new Date()).getTime();

    this._loadDummyVm({
        uuid: zonename
    }, function _onVmLoad(err, vmobj) {
        delete self.loadingVms[zonename];

        if (err && err.code === 'ENOENT') {
            if (evtName === 'delete') {
                handler({
                    type: 'delete',
                    vm: {},
                    zonename: zonename
                });
            } else {
                self.log.warn('VM ' + zonename + ' unexpectedly disappeared '
                    + 'while loading after ' + evtName);
            }
            return;
        }

       if (err) {
           self.log.error('error loading ' + zonename + ': ' + err.message);
           return;
       }

        handler({
            type: evtName,
            vm: vmobj,
            zonename: zonename
        });
    });
};



/* Try to load dummy sysinfo.json if present, otherwise proceed with an empty
 * object.
*/
DummyVmadm.prototype._stepMaybeLoadDummySysinfo =
function _stepMaybeLoadDummySysinfo(arg, callback) {
    assert.object(arg, 'arg');

    const fname = path.join(this.serverRoot, this.serverUuid, 'sysinfo.json');

    fs.readFile(fname, 'utf8', function onRead(err, data) {
        if (err && err.code === 'ENOENT') {
            arg.sysinfo = {};
            callback();
        } else if (err) {
            callback(err);
        } else {
            try {
                arg.sysinfo = JSON.parse(data);
            } catch (jsonErr) {
                callback(jsonErr);
            }
            callback();
        }
    });
};


/* If sysinfo is present, include some some properties in the vm object.
 */
DummyVmadm.prototype._stepAddSystemProperties =
function _stepAddSystemProperties(arg, callback) {
    // we know we loaded sysinfo if we got here (TODO: BUT....
    assert.object(arg, 'arg');
    assert.object(arg.sysinfo, 'arg.sysinfo');
    assert.object(arg.vmobj, 'arg.vmobj');

    if (arg.sysinfo.hasOwnProperty('UUID')) {
        arg.vmobj.server_uuid = arg.sysinfo.UUID;
    }

    if (arg.sysinfo.hasOwnProperty('Datacenter Name')) {
        arg.vmobj.datacenter_name = arg.sysinfo['Datacenter Name'];
    }

    if (arg.sysinfo.hasOwnProperty('Live Image')) {
        arg.vmobj.platform_buildstamp = arg.sysinfo['Live Image'];
    }

    // zpool?

    callback();
};

DummyVmadm.prototype._stepAddInstanceExecutionInfo =
function _stepAddInstanceExecutionInfo(arg, callback) {
    var last_modified;

    // XXX we just make stuff up for now
    assert.object(arg, 'arg');
    assert.object(arg.vmobj, 'arg.vmobj');

    if (arg.vmobj.state === undefined) {
        arg.vmobj.state = 'running';
    }

    if (arg.vmobj.state === 'running') {
        last_modified = (new Date(arg.vmobj.last_modified)).getTime();
        arg.vmobj.pid = Math.floor(last_modified / 1000) % 100000;
        if (arg.vmobj.boot_timestamp === undefined) {
            arg.vmobj.boot_timestamp = arg.vmobj.last_modified;
        }
    } else if (arg.vmobj.state === 'stopped') {
        arg.vmobj.exit_status = 0;
        if (arg.vmobj.exit_timestamp === undefined) {
            arg.vmobj.exit_timestamp = arg.vmobj.last_modified;
        }
    }

    callback();
};

DummyVmadm.prototype._stepAddHardcodedProperties =
function _stepAddHardcodedProperties(arg, callback) {
    // these make no sense here, so we hardcode them to something for compat
    assert.object(arg, 'arg');
    assert.object(arg.vmobj, 'arg.vmobj');

    assert.uuid(arg.vmobj.uuid, 'arg.vmobj.uuid');
    arg.vmobj.zonename = arg.vmobj.uuid;

    assert.string(arg.vmobj.state, 'arg.vmobj.state');
    arg.vmobj.zone_state = arg.vmobj.state;

    assert.optionalNumber(arg.vmobj.pid, 'arg.vmobj.pid');
    if (arg.vmobj.pid !== undefined) {
        arg.vmobj.zoneid = arg.vmobj.pid;
    }

    callback();
};


DummyVmadm.prototype._stepLoadTimestamp =
function _stepLoadTimestamp(arg, callback) {
    assert.object(arg, 'arg');
    assert.string(arg.file, 'arg.file');
    assert.object(arg.vmobj, 'arg.vmobj');

    fs.stat(arg.file, function _onStat(err, stats) {
        if (err) {
            callback(err);
            return;
        }

        arg.vmobj.last_modified = stats.mtime.toISOString();

        callback();
    });
};


DummyVmadm.prototype._loadDummyVm = function _loadDummyVm(opts, callback) {
    const self = this;
    assert.object(opts, 'opts');
    assert.uuid(opts.uuid, 'opts.uuid');

    const filename =
        path.join(this.serverRoot, this.serverUuid, 'vms', opts.uuid + '.json');

    fs.readFile(filename, function _onRead(err, data) {
        if (err) {
            callback(err);
            return;
        }

        // XXX will throw on bad data
        const vmobj = JSON.parse(data.toString());

        vasync.pipeline({
            arg: {
                file: filename,
                vmobj: vmobj
            },
            funcs: [
                self._stepMaybeLoadDummySysinfo.bind(self),
                self._stepLoadTimestamp.bind(self),
                self._stepAddInstanceExecutionInfo.bind(self),
                self._stepAddSystemProperties.bind(self),
                self._stepAddHardcodedProperties.bind(self)
            ]
        }, function _afterPipeline(pipelineErr) {
            callback(pipelineErr, vmobj);
        });
    });
};

DummyVmadm.prototype._loadDummyVms = function _loadDummyVms(opts, callback) {
    const self = this;
    assert.object(opts, 'opts');

    const vmdir = path.join(this.serverRoot, this.serverUuid, 'vms');

    fs.readdir(vmdir, function _onReadDir(err, files) {
        var filename;
        var idx;
        var matches;
        var toLoad = [];

        if (err) {
            callback(err);
            return;
        }

        for (idx = 0; idx < files.length; idx++) {
            filename = files[idx];

            if ((matches = filename.match(/^([a-f0-9-]*).json$/))) {
                toLoad.push(matches[1]);
            } else {
                self.log.warn('XXX WARNING: IGNORING: ' + filename);
            }
        }

        vasync.forEachParallel({
            func: function _loadVm(uuid, cb) {
                self._loadDummyVm({
                    uuid: uuid
                }, cb);
            },
            inputs: toLoad
        }, function _afterLoading(loadErr, results) {
            callback(loadErr, results.successes);
        });
    });
};


DummyVmadm.prototype._writeDummyVm =
function _writeDummyVm(vmobj, opts, callback) {
    const self = this;

    assert.object(vmobj);
    assert.object(opts);
    assert.func(callback);

    // TODO: asserts

    var fd;
    var filename;
    var finalFilename;
    var vmdir;
    vmdir = path.join(this.serverRoot, this.serverUuid, 'vms');
    filename = path.join(vmdir, vmobj.uuid + '.json');

    if (opts.atomicReplace) {
        finalFilename = filename;
        filename = filename + '.' + process.pid;
    }

    vasync.pipeline({
        funcs: [
            function _openFile(_, cb) {
                fs.open(filename, 'wx', function _onOpen(err, openedFd) {
                    if (err) {
                        cb(err);
                        return;
                    }
                    fd = openedFd;
                    cb();
                });
            }, function _writeThenCloseFile(_, cb) {
                var buf = new Buffer(JSON.stringify(vmobj, null, 2));

                fs.write(fd, buf, 0, buf.length, null, function _onWrite(err) {
                    if (err) {
                        cb(err);
                        return;
                    }
                    fs.close(fd, function _onWritten() {
                        cb();
                    });
                });
            }, function _atomicReplace(_, cb) {
                if (!opts.atomicReplace) {
                    cb();
                    return;
                }
                fs.rename(filename, finalFilename, cb);
            }
        ]
    }, function _onWroteVm(err) {
        self.log.info({err: err, uuid: vmobj.uuid}, 'wrote VM');
        callback(err);
    });
};


DummyVmadm.prototype._updateDummyVmState =
function _updateDummyVmState(opts, callback) {
    const self = this;
    assert.object(opts, 'opts');
    assert.uuid(opts.uuid, 'opts.uuid');
    assert.string(opts.state, 'opts.state');
    assert.optionalBool(opts.autoboot, 'opts.autoboot');

    this._loadDummyVm({
        uuid: opts.uuid
    }, function _onLoad(err, vmobj) {
        if (err) {
            callback(err);
            return;
        }

        if (opts.hasOwnProperty('autoboot')) {
            vmobj.autoboot = opts.autoboot;
        }
        vmobj.state = opts.state;

        self._writeDummyVm(vmobj, {
            atomicReplace: true
        }, function _onWrite(writeErr) {
            callback(writeErr);
        });
    });
};


// --- private helper functions

// wrap handler in a closure so we can keep the filename
function wrapHandler(filename, handler) {
    var fn = filename.slice(0);

    return (function _onFileEvent(evt) {
        handler(evt, fn);
    });
}

function zoneFromFilename(filename) {
    var matches;

    if ((matches = filename.match(/^(.*)\.json$/))) {
        assert.uuid(matches[1], 'zonename');
        return (matches[1]);
    }

    return undefined;
}

// -- event stream

// TODO: an we rename? Does this have to do anything?

// This implementation detail is now exposed as of TRITON-571 so we have to do
// this even though it makes no sense.
function VmadmCLIEventStream(opts) {
    assert.object(opts);
}
util.inherits(VmadmCLIEventStream, stream.Transform);


module.exports = DummyVmadm;
