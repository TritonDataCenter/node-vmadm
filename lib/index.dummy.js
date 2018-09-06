/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * A dummy version of node-vmadm using json files on the local file system
 */

var fs = require('fs');
var net = require('net');
var path = require('path');
var stream = require('stream');
var util = require('util');

var assert = require('assert-plus');
var vasync = require('vasync');
var uuidv4 = require('uuid/v4');

// These are the NIC properties that are boolean flags and we just remove when
// false.
var NIC_FLAGS = [
    'allow_dhcp_spoofing',
    'allow_ip_spoofing',
    'allow_mac_spoofing',
    'allow_restricted_traffic',
    'allow_unfiltered_promisc',
    'primary'
];
// NIC properties from vmadm's proptable.js
var NIC_PROPERTIES = [
    'allow_dhcp_spoofing',
    'allow_ip_spoofing',
    'allow_mac_spoofing',
    'allow_restricted_traffic',
    'allow_unfiltered_promisc',
    'allowed_dhcp_cids',
    'allowed_ips',
    'blocked_outgoing_ports',
    'dhcp_server',
    'gateway',
    'gateways',
    'interface',
    'ip',
    'ips',
    'mac',
    'model',
    'mtu',
    'netmask',
    'network_uuid',
    'nic_tag',
    'primary',
    'vlan_id',
    'vrrp_primary_ip',
    'vrrp_vrid'
];

/**
 * A dummy version of vmadm using json files on the local file system
 *
 * @param opts {Object} Options
 *      - log {Bunyan} Bunyan logger
 *      - eerverRoot {String} The file system path for dummy json files for this
 *        server to live.
 *      - sysinfo {Object} The sysinfo object for the server this vmadm serves.
 */
function DummyVmadm(opts) {
    assert.object(opts);
    assert.object(opts.log, 'opts.log');
    assert.string(opts.serverRoot, 'opts.serverRoot');
    assert.object(opts.sysinfo, 'opts.sysinfo');
    assert.uuid(opts.sysinfo.UUID, 'opts.sysinfo.UUID');

    var self = this;

    self.log = opts.log;
    self.serverRoot = opts.serverRoot;
    self.serverUuid = opts.sysinfo.UUID;
    self.sysinfo = opts.sysinfo;
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
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var self = this;

    self.load(opts, {fields: ['uuid']}, function _onLoad(err, vm) {
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

    var self = this;

    if (!callback) {
        callback = vmopts;
    }

    self.log.trace({
        req_id: opts.req_id,
        serverUuid: self.serverUuid,
        uuid: opts.uuid
    }, 'loading VM');

    self._loadVm({
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

    var self = this;
    var payload = opts;
    var req_id = opts.req_id;

    delete payload.log;
    delete payload.req_id;
    delete payload.sysinfo;
    delete payload.vmadmLogger;

    self.log.trace({
        req_id: req_id,
        payload: payload
    }, 'creating VM');

    assert.optionalUuid(payload.uuid, 'payload.uuid');
    if (!payload.hasOwnProperty('uuid')) {
        payload.uuid = uuidv4();
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

    payload.nics = filterNics(payload.nics);

    self._writeVm(payload, {}, function _onWrite(err) {
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
    assert.object(opts, 'opts');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var self = this;
    var filename;
    var vmdir;

    vmdir = path.join(self.serverRoot, self.serverUuid, 'vms');

    self.log.trace({
        req_id: opts.req_id,
        uuid: opts.uuid
    }, 'deleting VM');

    assert.uuid(opts.uuid, 'opts.uuid');
    filename = path.join(vmdir, opts.uuid + '.json');

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
 *      - include_dni {Boolean} If true, update VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */
DummyVmadm.prototype.update = function vmUpdate(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var self = this;
    var payload = opts;
    var req_id = opts.req_id;
    var routes;

    delete payload.log;
    delete payload.req_id;
    delete payload.vmadmLogger;

    self.log.trace({
        payload: payload,
        req_id: req_id,
        uuid: opts.uuid
    }, 'updating VM');

    self._loadVm({
        uuid: opts.uuid
    }, function _onLoad(err, vmobj) {
        var idx;
        var modified = false;
        var newNics;
        var SIMPLE_UPDATES = [
            'alias',
            'resolvers'
        ];

        if (err) {
            callback(err);
            return;
        }

        /*
         * For now we support updating:
         *
         *  - alias
         *  - resolvers
         *
         *  - add_nics
         *  - remove_nics
         *  - update_nics
         *
         *  - set_routes
         *  - remove_routes
         *
         */

        // These properties have the same name and we just swap for whatever's
        // in the payload.
        for (idx = 0; idx < SIMPLE_UPDATES.length; idx++) {
            if (payload.hasOwnProperty(SIMPLE_UPDATES[idx])) {
                vmobj[SIMPLE_UPDATES[idx]] = payload[SIMPLE_UPDATES[idx]];
                modified = true;
            }
        }

        // To match vmadm, we set_routes before remove_routes
        if (payload.hasOwnProperty('set_routes')) {
            routes = Object.keys(payload.set_routes);
            if (!vmobj.hasOwnProperty('routes')) {
                vmobj.routes = {};
            }
            for (idx = 0; idx < routes.length; idx++) {
                vmobj.routes[routes[idx]] = payload.set_routes[routes[idx]];
            }
        }

        if (payload.hasOwnProperty('remove_routes') && vmobj.routes) {
            routes = Object.keys(vmobj.routes);
            for (idx = 0; idx < routes.length; idx++) {
                if (vmobj.routes.hasOwnProperty(routes[idx])) {
                    modified = true;
                    delete vmobj.routes[routes[idx]];
                }
            }
        }

        if (payload.hasOwnProperty('add_nics') ||
            payload.hasOwnProperty('remove_nics') ||
            payload.hasOwnProperty('update_nics')) {

            if (rebuildNics(vmobj, payload)) {
                modified = true;
            }
        }

        if (modified) {
            self._writeVm(vmobj, {
                atomicReplace: true
            }, function _onWrite(writeErr) {
                callback(writeErr);
            });
        } else {
            callback();
        }
    });
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
    assert.object(opts, 'opts');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var self = this;
    var args = [];

    if (opts.force) {
        args.push('-F');
    }

    self.log.trace({
        args: args,
        force: Boolean(opts.force),
        req_id: opts.req_id,
        uuid: opts.uuid
    }, 'rebooting VM');

    vasync.pipeline({
        funcs: [
            function stepShutdown(_, next) {
                self._updateVmState({
                    autoboot: false,
                    state: 'shutting_down',
                    uuid: opts.uuid
                }, next);
            },
            function stepDown(_, next) {
                self._updateVmState({
                    state: 'stopped',
                    uuid: opts.uuid
                }, next);
            },
            function stepBoot(_, next) {
                self._updateVmState({
                    autoboot: true,
                    state: 'running',
                    uuid: opts.uuid
                }, next);
            }
        ]
    }, function afterPipeline(err) {
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

    var self = this;

    self.log.error({
        req_id: opts.req_id,
        search: search
    }, 'lookup VMs');

    // XXX can't we also specify fields in opts?

    self._loadVms({}, function _onLoadVms(err, loadedVms) {
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

    var self = this;

    self.log.trace({
        req_id: opts.req_id,
        uuid: opts.uuid
    }, 'start VM');

    self._updateVmState({
        autoboot: true,
        state: 'running',
        uuid: opts.uuid
    }, callback);
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

    var self = this;

    self.log.trace({
        req_id: opts.req_id,
        uuid: opts.uuid
    }, 'stop VM');

    self._updateVmState({
        autoboot: false,
        state: 'stopped',
        uuid: opts.uuid
    }, callback);
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
DummyVmadm.prototype.events = function vmEvents(_opts, handler, callback) {
    var self = this;
    var vmdir = path.join(self.serverRoot, self.serverUuid, 'vms');

    self.fileWatches = {};
    self.loadingVms = {};

    // load initial set of files so we know when things change
    fs.readdir(vmdir, function _onReadDir(err, files) {
        var filename;
        var idx;
        var modifyHandler;

        // XXX what to do on error

        self.instanceFiles = files;

        for (idx = 0; idx < files.length; idx++) {
            filename = files[idx];

            if (!zoneFromFilename(filename)) {
                self.log.warn({filename: filename}, 'events: ignoring non-vm');
                continue;
            }

            // need to make a closure with a copy of the filename since
            // node doesn't give it to us w/ the event.
            modifyHandler = wrapHandler(filename, function _onModify(_evt, fn) {
                fs.exists(path.join(vmdir, fn), function _onExists(exists) {
                    if (exists) {
                        self._dispatchEvent('modify', zoneFromFilename(fn),
                            {sysinfo: self.sysinfo}, handler);
                    } else {
                        self.log.warn({filename: fn}, 'ignoring modify event '
                            + 'for deleted file');
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
            var filename;
            var idx;
            var modifyHandler;
            var vmFiles;

            // filter out temporary files from atomicRename
            vmFiles = files.filter(function onFile(fname) {
                return fname.endsWith('.json');
            });

            // XXX what to do on error

            // XXX this is a pretty inefficient way to generate the
            // added/deleted

            for (idx = 0; idx < vmFiles.length; idx++) {
                filename = vmFiles[idx];

                if (!zoneFromFilename(filename)) {
                    self.log.warn({filename: filename}, 'ignoring non-vm');
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
                                    {sysinfo: self.sysinfo}, handler);
                            } else {
                                self.log.warn({filename: fn}, 'ignoring modify'
                                    + ' event for deleted file');
                            }
                        });
                    });

                    self.fileWatches[filename] =
                        fs.watch(path.join(vmdir, filename), {},
                            modifyHandler);

                    self._dispatchEvent('create', zoneFromFilename(filename),
                        {sysinfo: self.sysinfo}, handler);
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
                        {sysinfo: self.sysinfo}, handler);
                }
            }

            // replace with new list
            self.instanceFiles = vmFiles;
        });
    });

    // We do this with setImmediate because the node-vmadm callers depend on
    // getting the return value and using it before the callback runs.
    setImmediate(function _eventuallyCallCallback() {
        self._loadVms({}, function _onLoadVms(err, loadedVms) {
            var idx;
            var vms = {};

            if (!err) {
                for (idx = 0; idx < loadedVms.length; idx++) {
                    vms[loadedVms[idx].uuid] = loadedVms[idx];
                }
            }

            callback(null, {
                ev: {
                    date: (new Date()).toISOString(),
                    type: 'ready',
                    vms: vms
                },
                stop: function _stop() {
                    self._deleteAllWatchers();
                }
            });
        });
    });

    return new VmadmCLIEventStream();
};

// --- dummy helper methods

DummyVmadm.prototype._deleteAllWatchers = function _deleteAllWatchers() {
    var self = this;
    var filename;
    var idx;
    var keys;

    keys = Object.keys(self.fileWatches);
    for (idx = 0; idx < keys.length; idx++) {
        filename = keys[idx];

        self.log.trace({filename: filename}, 'deleting file watch');
        self.fileWatches[filename].close();
        delete self.fileWatches[filename];
    }
};

DummyVmadm.prototype._dispatchEvent =
function _dispatchEvent(evtName, zonename, opts, handler) {
    assert.string(evtName, 'evtName');
    assert.uuid(zonename, 'zonename');
    assert.object(opts, 'opts');
    assert.func(handler, 'handler');

    var self = this;

    if (self.loadingVms[zonename]) {
        self.log.trace({zonename: zonename}, 'dispatchEvent skipping zone'
            + ' which is already being loaded');
        return;
    }
    self.loadingVms[zonename] = (new Date()).getTime();

    self._loadVm({
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
                self.log.error({evtname: evtName, zonename: zonename},
                    'VM unexpectedly disappeared while loading after event');
            }
            return;
        }

       if (err) {
            self.log.error({err: err, zonename: zonename}, 'error loading VM');
            return;
        }

        handler({
            type: evtName,
            vm: vmobj,
            zonename: zonename
        });
    });
};

DummyVmadm.prototype._addSystemProperties =
function _addSystemProperties(arg, callback) {
    // we know we loaded sysinfo if we got here
    assert.object(arg, 'arg');
    assert.object(arg.vmobj, 'arg.vmobj');

    var self = this;

    arg.vmobj.server_uuid = self.sysinfo.UUID;

    assert.string(self.sysinfo['Datacenter Name'],
        'self.sysinfo[\'Datacenter Name\']');
    arg.vmobj.datacenter_name = self.sysinfo['Datacenter Name'];

    assert.string(self.sysinfo['Live Image'], 'self.sysinfo[\'Live Image\']');
    arg.vmobj.platform_buildstamp = self.sysinfo['Live Image'];

    // zpool?

    callback();
};

DummyVmadm.prototype._addInstanceExecutionInfo =
function _addInstanceExecutionInfo(arg, callback) {
    assert.object(arg, 'arg');
    assert.object(arg.vmobj, 'arg.vmobj');

    var last_modified;

    // XXX we just make stuff up for now

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

DummyVmadm.prototype._addHardcodedProperties =
function _addHardcodedProperties(arg, callback) {
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

DummyVmadm.prototype._loadTimestamp = function _loadTimestamp(arg, callback) {
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

DummyVmadm.prototype._loadVm = function _loadVm(opts, callback) {
    assert.object(opts, 'opts');
    assert.uuid(opts.uuid, 'opts.uuid');

    var self = this;
    var filename = path.join(self.serverRoot, self.sysinfo.UUID,
        'vms', opts.uuid + '.json');
    var vmobj;

    fs.readFile(filename, function _onRead(err, data) {
        if (err) {
            callback(err);
            return;
        }

        // XXX will throw on bad data
        vmobj = JSON.parse(data.toString());

        vasync.pipeline({
            arg: {
                file: filename,
                vmobj: vmobj,
                sysinfo: self.sysinfo
            },
            funcs: [
                self._loadTimestamp.bind(self),
                self._addInstanceExecutionInfo.bind(self),
                self._addSystemProperties.bind(self),
                self._addHardcodedProperties.bind(self)
            ]
        }, function _afterPipeline(pipelineErr) {
            callback(pipelineErr, vmobj);
        });
    });
};

DummyVmadm.prototype._loadVms = function loadVms(_opts, callback) {
    var self = this;
    var vmdir;

    vmdir = path.join(self.serverRoot, self.sysinfo.UUID, 'vms');

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

            matches = filename.match(/^([a-f0-9-]*).json$/);
            if (matches) {
                toLoad.push(matches[1]);
            } else {
                console.error('XXX WARNING: IGNORING: ' + filename);
            }
        }

        vasync.forEachParallel({
            func: function _loadVm(uuid, cb) {
                self._loadVm({
                    serverRoot: self.serverRoot,
                    sysinfo: self.sysinfo,
                    uuid: uuid
                }, cb);
            },
            inputs: toLoad
        }, function _afterLoading(loadErr, results) {
            callback(loadErr, results.successes);
        });
    });
};

DummyVmadm.prototype._writeVm =
function _writeVm(vmobj, opts, callback) {
    assert.object(vmobj, 'vmobj');
    assert.object(opts, 'opts');
    assert.optionalBool(opts.atomicReplace, 'opts.atomicReplace');
    assert.func(callback);

    var self = this;
    var fd;
    var filename;
    var finalFilename;
    var vmdir;

    vmdir = path.join(self.serverRoot, self.serverUuid, 'vms');
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
                var buf = new Buffer(JSON.stringify(vmobj, null, 2) + '\n');

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

DummyVmadm.prototype._updateVmState = function _updateVmState(opts, callback) {
    assert.object(opts, 'opts');
    assert.uuid(opts.uuid, 'opts.uuid');
    assert.string(opts.state, 'opts.state');
    assert.optionalBool(opts.autoboot, 'opts.autoboot');

    var self = this;

    self._loadVm({
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

        self._writeVm(vmobj, {
            atomicReplace: true
        }, function _onWrite(writeErr) {
            callback(writeErr);
        });
    });
};

// --- private helper functions

/*
 * Converts a dotted IPv4 address (eg: 1.2.3.4) to its integer value
 */
// Copied from smartos-live/src/vm/node_modules/ip.js
function addressToNumber(addr) {
    if (!addr || !net.isIPv4(addr)) {
        return null;
    }

    var octets = addr.split('.');
    return Number(octets[0]) * 16777216
        + Number(octets[1]) * 65536
        + Number(octets[2]) * 256
        + Number(octets[3]);
}

/*
 * Converts netmask to CIDR (/xx) bits
 */
// Copied from smartos-live/src/vm/node_modules/ip.js
function netmaskToBits(netmask) {
    var num = ~addressToNumber(netmask);
    var b = 0;
    for (b = 0; b < 32; b++) {
        if (num === 0) {
            break;
        }
        num = num >>> 1;
    }
    return 32 - b;
}

// Copied from smartos-live/src/vm/node_modules/utils.js
function isPrivateIP(str)
{
    if (!net.isIPv4(str)) {
        return false;
    }

    function inRange(start, end, prospect) {
        if (addressToNumber(start) <= addressToNumber(prospect)
            && addressToNumber(prospect) <= addressToNumber(end)) {

            return true;
        }
        return false;
    }

    if (inRange('10.0.0.0', '10.255.255.255', str)) {
        return true;
    } else if (inRange('172.16.0.0', '172.31.255.255', str)) {
        return true;
    } else if (inRange('192.168.0.0', '192.168.255.255', str)) {
        return true;
    }

    return false;
}

// Filters an array of nic-like objects and returns an array of NIC objects
// with only known properties.
function filterNics(nics) {
    assert.arrayOfObject(nics, 'nics');

    var filteredNic;
    var nic;
    var nicIdx;
    var nicPropKeys;
    var prop;
    var propIdx;
    var results = [];

    for (nicIdx = 0; nicIdx < nics.length; nicIdx++) {
        filteredNic = {};
        nic = nics[nicIdx];

        nicPropKeys = Object.keys(nic);
        for (propIdx = 0; propIdx < nicPropKeys.length; propIdx++) {
            prop = nicPropKeys[propIdx];

            if (NIC_PROPERTIES.indexOf(prop) !== -1) {
                filteredNic[prop] = nic[prop];
            }
        }

        // This will modify the NIC to deal with ip/ips, gateway/gateways
        handleIpsMess(filteredNic);

        results.push(filteredNic);
    }

    return (results);
}

// Deals with the ip/ips, gateway/gateways mess. Modifies nic in-place.
function handleIpsMess(nic) {

    // Deal with multiple IP stuff
    if (nic.hasOwnProperty('ip') && !nic.hasOwnProperty('ips')) {
        assert.string(nic.netmask, 'nic.netmask');
        nic.ips = [nic.ip + '/' + netmaskToBits(nic.netmask)];
    }
    if (nic.hasOwnProperty('ips') &&
        nic.ips.length > 0 &&
        !nic.hasOwnProperty('ip')) {

        nic.ip = nic.ips[0].split('/')[0];
    }

    // Now multiple gateways stuff
    if (nic.hasOwnProperty('gateway') && !nic.hasOwnProperty('gateways')) {
        nic.gateways = [nic.gateway];
    }
    if (nic.hasOwnProperty('gateways') &&
        nic.gateways.length > 0 &&
        !nic.hasOwnProperty('gateway')) {

        nic.gateway = nic.gateways[0];
    }
}

// Returns true if vmobj.nics was modified, false otherwise.
function rebuildNics(vmobj, payload) {
    assert.object(vmobj, 'vmobj');
    assert.object(payload, 'payload');

    var addingPrimary = false;
    var changingPrimary = false;
    var modified = false;
    var nicIdx;
    var nicProp;
    var nicProps;
    var nicPropIdx;
    var numNewPrimaries;
    var oldNicIdx;
    var privateCandidate;
    var publicCandidate;
    var removingPrimary = false;

    if (payload.hasOwnProperty('add_nics')) {
        payload.add_nics = filterNics(payload.add_nics);
        for (nicIdx = 0; nicIdx < payload.add_nics.length; nicIdx++) {
            nic = payload.add_nics[nicIdx];

            // When adding nics, we remove any flags that are false, since false
            // is the default.
            for (nicPropIdx = 0; nicPropIdx < NIC_FLAGS.length; nicPropIdx++) {
                nicProp = NIC_FLAGS[nicPropIdx];
                if (nic.hasOwnProperty(nicProp) && nic[nicProp] === false) {
                    delete nic[nicProp];
                }
            }

            if (nic.primary) {
                addingPrimary = true;
            }
        }
    }

    if (payload.hasOwnProperty('update_nics')) {
        payload.update_nics = filterNics(payload.update_nics);
        for (nicIdx = 0; nicIdx < payload.update_nics.length; nicIdx++) {
            nic = payload.update_nics[nicIdx];

            if (nic.primary) {
                changingPrimary = true;
            }
        }
    }

    if (payload.hasOwnProperty('remove_nics')) {
        vmobj.nics = vmobj.nics.filter(function _removeNics(nic) {
            if (payload.remove_nics.indexOf(nic.mac) !== -1) {
                // This is on the removal list, see if it was primary then
                // mark for removal.
                if (nic.primary) {
                    removingPrimary = true;
                }
                return false; // don't keep
            }
            return true; // keep
        });
    }

    numNewPrimaries = 0;
    if (addingPrimary || changingPrimary) {
        // remove primary from any existing NICs
        for (oldNicIdx = 0; oldNicIdx < vmobj.nics.length; oldNicIdx++) {
            if (vmobj.nics[oldNicIdx].primary) {
                delete vmobj.nics[oldNicIdx].primary;
                modified = true;
            }
        }

        // make sure only 1 new / updated nic is primary
        if (payload.hasOwnProperty('add_nics')) {
            for (nicIdx = 0; nicIdx < payload.add_nics.length; nicIdx++) {
                if (payload.add_nics[nicIdx].primary) {
                    numNewPrimaries++;
                }
            }
        }
        if (payload.hasOwnProperty('update_nics')) {
            for (nicIdx = 0; nicIdx < payload.update_nics.length; nicIdx++) {
                if (payload.update_nics[nicIdx].primary) {
                    numNewPrimaries++;
                }
            }
        }

        // This is an error in the payload and it's not clear what we should
        // do about it. Adding and updating nics to set more than 1 primary
        // is not supported.
        assert.ok((numNewPrimaries <= 1), 'should have at most 1 primary nic');
    }

    if (removingPrimary && numNewPrimaries === 0) {
        // If we're removing the existing primary NIC, we need to set a new
        // primary. We do what vmadm does: choose the first NIC that has a
        // private IP, otherwise the first NIC with an IP at all.
        for (oldNicIdx = 0; oldNicIdx < vmobj.nics.length; oldNicIdx++) {
            if (isPrivateIP(vmobj.nics[oldNicIdx].ip)) {
                if (privateCandidate === undefined) {
                    privateCandidate = vmobj.nics[oldNicIdx];
                } else if (publicCandidate === undefined) {
                    publicCandidate = vmobj.nics[oldNicIdx];
                }
            }
        }

        if (privateCandidate !== undefined) {
            privateCandidate.primary = true;
            modified = true;
        } else if (publicCandidate !== undefined) {
            publicCandidate.primary = true;
            modified = true;
        }
    }

    if (payload.hasOwnProperty('add_nics')) {
        vmobj.nics = vmobj.nics.concat(payload.add_nics);
        modified = true;
    }

    if (payload.hasOwnProperty('update_nics')) {
        for (oldNicIdx = 0; oldNicIdx < vmobj.nics.length; oldNicIdx++) {
            for (nicIdx = 0; nicIdx < payload.update_nics.length; nicIdx++) {
                if (vmobj.nics[oldNicIdx].mac ===
                    payload.update_nics[nicIdx].mac) {

                    // Take props from payload.update_nics[nicIdx] and set them
                    // on vmobj.nics[oldNicIdx]
                    nicProps = Object.keys(payload.update_nics[nicIdx]);
                    for (nicPropIdx = 0; nicPropIdx < nicProps.length;
                        nicPropIdx++) {

                        nicProp = nicProps[nicPropIdx];

                        // For boolean flags, we just remove if they're false.
                        if (NIC_FLAGS.indexOf(nicProp) !== -1 &&
                            payload.update_nics[nicIdx][nicProp] === false) {

                            delete vmobj.nics[oldNicIdx][nicProp];
                        } else {
                            vmobj.nics[oldNicIdx][nicProp]
                                = payload.update_nics[nicIdx][nicProp];
                        }
                        modified = true;
                    }
                }
            }
        }
    }

    return modified;
}

// wrap handler in a closure so we can keep the filename
function wrapHandler(filename, handler) {
    var fn = filename.slice(0);

    return (function _onFileEvent(evt) {
        handler(evt, fn);
    });
}

function zoneFromFilename(filename) {
    var matches;

    matches = filename.match(/^(.*)\.json$/);
    if (matches) {
        assert.uuid(matches[1], 'zonename');
        return (matches[1]);
    }

    return undefined;
}

// -- event stream

// This implementation detail is now exposed as of TRITON-571 so we have to do
// this even though it makes no sense.
function VmadmCLIEventStream(_opts) {
}
util.inherits(VmadmCLIEventStream, stream.Transform);

module.exports = DummyVmadm;
