/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

const assert = require('assert-plus');
const fs = require('fs');
const uuidv4 = require('uuid');
const vasync = require('vasync');
const { Machine, VMADM_CONFIG_DIR } = require('./machine');


function fake_sysinfo() {
    // XXX get required info about PI, zpool(s)
    return {
        'Live Image': '20200401T123456Z',
        'System Type': 'Linux',
        'Zpool': 'triton'
    };
}


/**
 * Return a copy of obj that contains only those properties listed in fields.
 * This is not a deep copy, so modification of fields in the returned value can
 * effect obj.
 * @param {Object} obj - Any object.
 * @param {Array|Set} fields - The fields to copy.
 * @returns {Object}
 */
function copyObj(obj, fields) {
    var ret = {};

    fields = new Set(fields);

    for (let i of fields) {
        if (i !== undefined && obj.hasOwnProperty(i)) {
            ret[i] = obj[i];
        }
    }

    return ret;
}


class LinuxVmadm {
    constructor(opts) {
        assert.object(opts, 'opts');
        assert.object(opts.log, 'opts.log');
        assert.func(opts.log.trace, 'opts.log.trace');
        assert.func(opts.log.debug, 'opts.log.debug');
        assert.func(opts.log.info, 'opts.log.info');
        assert.func(opts.log.warn, 'opts.log.warn');
        assert.func(opts.log.error, 'opts.log.error');
        assert.optionalString(opts.configdir, 'opts.configdir');
        assert.optionalObject(opts.sysinfo, 'opts.sysinfo');
        var self = this;
        self.log = opts.log;

        if (opts.sysinfo) {
            self.sysinfo = opts.sysinfo;
        } else {
            self.sysinfo = fake_sysinfo();
        }

        self.machConstOpts = {
            log: opts.log,
            configdir: opts.configdir,
            sysinfo: self.sysinfo
        };

        // Avoid repeatedly reloading VMs.
        self.cache = {};
    }


    _getMachine(id) {
        var self = this;

        if (!self.cache[id]) {
            self.cache[id] = new Machine(self.machConstOpts, id);
        }
        return self.cache[id];
    }


    /**
     * Check whether a VM exists or not.
     *
     * @param opts {Object} Options
     *      - uuid {String} The VM uuid.
     *      - log {Logger object}
     *      - include_dni {Boolean} If true, return VMs that have
     *        do_not_inventory set. default: false.
     * @param callback {Function} `function (err, exists)`
     *      - err is set on unhandled error
     *      - otherwise; exists will be true or false
     */
    exists(opts, callback) {
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.string(opts.uuid, 'opts.uuid');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');
        var self = this;

        var log = opts.log || self.log;
        var machine = self._getMachine(opts.uuid);

        machine.exists({ need_props: !opts.include_dni },
            function _exists(err, result) {

            if (err) {
                log.error({error: err}, 'Unable to check existence of ' +
                    `${opts.uuid}: ${err.message}`);
                callback(err);
                return;
            }
            if (!result) {
                log.trace({ uuid: opts.uuid }, 'Machine does not exist');
                delete self.cache[opts.uuid];
                callback(null, false);
                return;
            }
            if (!opts.include_dni && machine.get('do_not_inventory')) {
                log.trace({ uuid: opts.uuid },
                    'Machine exists but has do_not_invetory=true');
                callback(null, false);
                return;
            }
            log.trace({ uuid: opts.uuid }, 'Machine exists');
            callback(null, true);
        });
    }


    /**
     * Call different callbacks based on whether the machine exists
     * @param {Object} opts
     * @param {UUID} opts.uuid - The uuid of the machine.
     * @param {boolean} [opts.include_dni] - If not true, do not call exists_cb
     *        for machines that have do_not_inventory=true.
     * @param {function} exists_cb - called as exists_db(machine) if the
     *        machine exists (subject to opts.include_dni, above).
     * @param {function} callback - called as callback(err) on error callback()
     *        when there is no error and the machine does not exist.
     */
    ifExists(opts, exists_cb, callback) {
        assert.object(opts, 'opts');
        assert.uuid(opts.uuid, 'opts.uuid');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');
        assert.function(exists_cb, 'exists_cb');
        assert.function(callback, 'callback');
        var self = this;

        self.exists(opts, function existsCb(err, exists) {
            if (err) {
                callback(err);
                return;
            }
            if (exists) {
                exists_cb(self._getMachine(opts.uuid));
                return;
            }
            callback();
        });
    }


    /**
     * Call `vmadm get UUID`.
     *
     * @param opts {Object} Options
     *      - uuid {String} The VM uuid.
     *      - log {Logger object}
     * @param vmopts {Object} Optional vm options
     *      - fields {Array} Return only the keys give in `fields` array
     *      - include_dni {Boolean} If true, return VMs that have
     *        do_not_inventory set. default: false.
     * @param callback {Function} `function (err)`
     */
    load(opts, vmopts, callback) {
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.string(opts.uuid, 'opts.uuid');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');
        var self = this;

        if (!callback) {
            callback = vmopts;
        }

        var log = opts.log || self.log;
        var machine = self._getMachine(opts.uuid);
        var machopts = copyObj(opts, ['req_id', 'uuid']);

        log.trace(machopts, 'loading machine');

        machine.load(machopts, function (err, vm) {
            function notFound() {
                var notFoundErr;

                // NOTE: destroy depends on this matching ': No such zone'
                notFoundErr = new Error('vmadm load ' + opts.uuid +
                    ' failed: No such zone');
                notFoundErr.restCode = 'VmNotFound';

                return notFoundErr;
            }

            if (err) {
                if (err.code === 'ENOENT') {
                    callback(notFound());
                } else {
                    callback(err);
                }
                return;
            }

            if (vm.do_not_inventory && !opts.include_dni) {
                // Unless the caller is specifically asking for VMs that are
                // do_not_inventory, we treat them the same a VMs that don't
                // exist.
                log.trace(machopts,
                    'Machine exists but has do_not_inventory=true');
                callback(notFound());
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
        });
    }


    /**
     * Call `vmadm create`.
     *
     * @param opts {Object} Options
     *      - log {Logger object}
     * @param callback {Function} `function (err, info)`
     */
    create(opts, callback) {
        assert.object(opts, 'opts');
        assert.optionalUuid(opts.uuid, 'opts.uuid');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');

        var self = this;
        var log = opts.log || self.log;
        var payload = opts;
        opts = copyObj(opts, ['req_id', 'uuid']);
        log.trace(payload, 'creating machine');

        delete payload.log;
        delete payload.req_id;
        delete payload.vmadmLogger;

        payload.uuid = payload.uuid || uuidv4();
        delete self.cache[payload.uuid];
        var machine = self._getMachine(payload.uuid);

        try {
            machine.setAllProps(opts, payload);
            machine.validate();
        } catch (err) {
            callback(err, null);
            return;
        }

        machine.install(opts, function created(err) {
            if (err) {
                callback(err);
                return;
            }
            var info = {
                uuid: payload.uuid
            };

            callback(null, info);
        });
    }


    /**
     * Call `vmadm delete <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of VM to delete
     *      - log {Logger object}
     *      - include_dni {Boolean} If true, delete VMs that have
     *        do_not_inventory set. default: false.
     * @param callback {Function} `function (err)`
     */
    delete(opts, callback) {
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.string(opts.uuid, 'opts.uuid');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');

        var self = this;
        var log = opts.log || self.log;
        var machopts = copyObj(opts, ['req_id', 'uuid']);
        log.trace(machopts, 'creating machine');

        self.ifExists(opts, function ifExistsCb(machine) {
            machine.uninstall(machopts, callback);
        }, callback);
    }


    /**
     * Call `vmadm update`.
     *
     * @param opts {Object} VMADM update payload
     *      - log {Logger object}
     *      - include_dni {Boolean} If true, update VMs that have
     *        do_not_inventory set. default: false.
     * @param callback {Function} `function (err)`
     */
    update(opts, callback) {
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.string(opts.uuid, 'opts.uuid');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');

        var self = this;
        var log = opts.log || self.log;
        var existsOpts = copyObj(opts, ['req_id', 'uuid', 'include_dni']);
        existsOpts.log = log;

        // Transform opts to payload.
        delete opts.log;
        delete opts.req_id;
        delete opts.vmadmLogger;
        delete opts.include_dni;

        log.trace(opts, 'updating machine');
        var machopts = copyObj(opts, ['req_id', 'uuid']);

        self.ifExists(existsOpts, function ifExistsCb(machine) {
            machine.update(machopts, opts, callback);
        }, callback);
    }


    /**
     * Call `vmadm reboot <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of VM to reboot
     *      - force {Boolean} Whether to force the reboot.
     *      - log {Logger object}
     *      - include_dni {Boolean} If true, reboot VMs that have
     *        do_not_inventory set. default: false.
     * @param callback {Function} `function (err)`
     */
    reboot(opts, callback) {
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.string(opts.uuid, 'opts.uuid');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');

        var self = this;
        var log = opts.log || self.log;
        var machopts = copyObj(opts, ['req_id', 'uuid', 'force']);
        log.trace(machopts, 'rebooting machine');

        self.ifExists(opts, function _ifExistsCb(machine) {
            machine.reboot(machopts, callback);
        }, callback);
    }


    /**
     * Call `vmadm reprovision`.
     *
     * @param opts {Object} VMADM reprovision payload
     *      - log {Logger object}
     *      - uuid {String} uuid of vm to be reprovisioned
     *      - include_dni {Boolean} If true, reprovision VMs that have
     *        do_not_inventory set. default: false.
     * @param callback {Function} `function (err)`
     */
    reprovision(opts, callback) {
        assert.object(opts, 'opts');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.string(opts.uuid, 'opts.uuid');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');

        callback(new Error('reprovision not supported'));
    }


    /**
     * Call `vmadm lookup -j`.
     *
     * @param opts {Object} Options
     *      - uuid {String} The VM uuid.
     *      - log {Logger object}
     * @param vmopts {Object} Optional vm options
     *      - fields {Array} Return only the keys give in `fields` array
     *      - include_dni {Boolean} If true, return VMs that have
     *        do_not_inventory set. default: false.
     * @param callback {Function} `function (err, vms)`
     */
    lookup(search, opts, callback) {
        assert.object(search, 'search');
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');

        var self = this;
        var fields = new Set(opts.fields || []);
        fields.add('uuid');
        var file_re = /^([0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})\.json$/;
        var vms = [];

        self.log.trace({
            search: search,
            opts: copyObj(opts, ['fields', 'req_id', 'include_dni'])
        }, 'loading machines');

        function loadOneVm(id, next) {
            var loadopts = {
                include_dni: opts.include_dni,
                uuid: id
            };
            self.vmLoad(loadopts, function loaded(err, vmobj) {
                var name;

                if (err) {
                    self.log.warn({ err: err, req_id: opts.req_id },
                        `failed to load ${id}: ${err.message}`);
                    // XXX What is the right thing to do when failing to load
                    // one?  Is that the same thing when all fail to load?
                    next();
                }

                for (name in search) {
                    if (vmobj[name] === search[name]) {
                        continue;
                    }
                    self.log.trace({
                        search: search,
                        propname: name,
                        uuid: id
                    }, `Excluding machine due to search name=${name}`);
                    next();
                    return;
                }

                if (fields.size !== 0) {
                    for (name in vmobj) {
                        if (!fields.has(name)) {
                            delete vmobj[name];
                        }
                    }
                }
                self.log.trace({vmobj: vmobj, req_id: opts.req_id},
                    `lookup loaded machine ${id}`);

                vms.push(vmobj);
            });
        }

        fs.readdir(VMADM_CONFIG_DIR, function readDir(err, files) {
            if (err) {
                callback(err);
                return;
            }
            vasync.forEachParallel({
                func: loadOneVm,
                inputs: files.filter(f => f.match(file_re))
                    .map(f => f.match(file_re)[1])
            }, callback);
        });
    }


    /**
     * Call `vmadm kill <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of VM to kill
     *      - log {Logger object}
     *      - signal {String} Optional signal to send, eg 'SIGTERM'
     *      - include_dni {Boolean} If true, kill VMs that have do_not_inventory
     *        set. default: false.
     * @param callback {Function} `function (err)`
     */
    kill(opts, callback) {
        assert.object(opts, 'opts');
        assert.OptionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.string(opts.uuid, 'opts.uuid');
        assert.optionalString(opts.signal, 'opts.signal');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');
        var self = this;
        var log = opts.log || self.log;

        var machopts = copyObj(opts, ['req_id', 'uuid', 'signal']);
        log.trace(machopts, 'killing machine');

        self.ifExists(opts, function _ifExistsCb(machine) {
            machine.reboot(machopts, callback);
        }, callback);
    }


    /**
     * Call `vmadm info <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of KVM to run info on
     *      - log {Logger object}
     *      - types {Array of Strings} Optional array of type strings
     *      - include_dni {Boolean} If true, gather info from VMs that have
     *        do_not_inventory set. default: false.
     * @param callback {Function} `function (err)`
     */
    info(opts, callback) {
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.string(opts.uuid, 'opts.uuid');
        assert.optionalArrayOfString(opts.types, 'opts.types');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');

        callback(new Error('info not supported'));
    }


    /**
     * Call `vmadm sysrq <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of KVM to run sysrq on
     *      - log {Logger object}
     *      - req {String} Type of request, 'screenshot' or 'nmi'
     *      - include_dni {Boolean} If true, send sysrq to VMs that have
     *        do_not_inventory set. default: false.
     * @param callback {Function} `function (err)`
     */
    sysrq(opts, callback) {
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.string(opts.req, 'opts.req');
        assert.string(opts.uuid, 'opts.uuid');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');

        callback(new Error('sysrq not supported'));
    }


    /**
     * Call `vmadm create-snapshot <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID VM to snapshot
     *      - log {Logger object}
     *      - snapshot_name {String} name to give the snapshot
     *      - include_dni {Boolean} If true, snapshot VMs that have
     *        do_not_inventory set. default: false.
     * @param callback {Function} `function (err)`
     */
    create_snapshot(opts, callback) {
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.string(opts.snapshot_name, 'opts.snapshot_name');
        assert.string(opts.uuid, 'opts.uuid');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');
        var self = this;
        var log = opts.log || self.log;

        var machopts = copyObj(opts, ['req_id', 'uuid', 'snapshot_name']);
        log.trace(machopts, 'creating snapshot of machine');

        self.ifExists(opts, function _ifExistsCb(machine) {
            machine.snapshot(machopts, callback);
        }, callback);
    }


    /**
     * Call `vmadm rollback-snapshot <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of VM container snapshot to rollback
     *      - log {Logger object}
     *      - snapshot_name {String} name of snapshot to rollback
     *      - include_dni {Boolean} If true, rollback snapshots for VMs that
     *        have do_not_inventory set. default: false.
     * @param callback {Function} `function (err)`
     */
    rollback_snapshot(opts, callback) {
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.string(opts.snapshot_name, 'opts.snapshot_name');
        assert.string(opts.uuid, 'opts.uuid');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');
        var self = this;
        var log = opts.log || self.log;

        var machopts = copyObj(opts, ['req_id', 'uuid', 'snapshot_name']);
        log.trace(machopts, 'rolling back snapshot of machine');

        self.ifExists(opts, function _ifExistsCb(machine) {
            machine.rollbackSnapshot(machopts, callback);
        }, callback);
    }


    /**
     * Call `vmadm delete-snapshot <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of VM container snapshot to delete
     *      - log {Logger object}
     *      - snapshot_name {String} name of the snapshot to delete
     *      - include_dni {Boolean} If true, delete snapshots for VMs that have
     *        do_not_inventory set. default: false.
     * @param callback {Function} `function (err)`
     */
    delete_snapshot(opts, callback) {
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.string(opts.snapshot_name, 'opts.snapshot_name');
        assert.string(opts.uuid, 'opts.uuid');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');
        var self = this;
        var log = opts.log || self.log;

        var machopts = copyObj(opts, ['req_id', 'uuid', 'snapshot_name']);
        log.trace(machopts, 'deleting snapshot of machine');

        self.ifExists(opts, function _ifExistsCb(machine) {
            machine.deleteSnapshot(machopts, callback);
        }, callback);
    }


    /**
     * Call `vmadm start <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of VM to start
     *      - log {Logger object}
     *      - include_dni {Boolean} If true, start VMs that have
     *        do_not_inventory set. default: false.
     * @param callback {Function} `function (err)`
     */
    start(opts, callback) {
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.string(opts.uuid, 'opts.uuid');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');
        var self = this;
        var log = opts.log || self.log;

        var machopts = copyObj(opts, ['req_id', 'uuid']);
        log.trace(machopts, 'starting machine');

        self.ifExists(opts, function _ifExistsCb(machine) {
            machine.start(machopts, callback);
        }, callback);
    }


    /**
     * Call `vmadm stop <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of VM to stop
     *      - force {Boolean} Whether to force the stop
     *      - log {Logger object}
     *      - include_dni {Boolean} If true, stop VMs that have do_not_inventory
     *        set. default: false.
     *      - timeout {Number} If set, timeout in seconds between sending
     *        SIGTERM and SIGKILL when stopping docker containers.
     * @param callback {Function} `function (err)`
     */
    stop(opts, callback) {
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.optionalNumber(opts.timeout, 'opts.timeout');
        assert.string(opts.uuid, 'opts.uuid');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');
        var self = this;
        var log = opts.log || self.log;

        var machopts = copyObj(opts, ['req_id', 'uuid', 'force', 'timeout']);
        log.trace(machopts, 'stopping machine');

        self.ifExists(opts, function _ifExistsCb(machine) {
            machine.stop(machopts, callback);
        }, callback);
    }


    /*
     * Wrapper around `vmadm events -jr [uuid]`
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of VM to watch, if unset all VMs are watched
     *      - log {Logger object}
     *      - name {String} Identifier string for debugging purposes, this will
     *        be used to construct the user-agent sent to vminfod
     * @param handler {Function} `function (ev)`
     *      - called when an event is seen
     * @param callback {Function} `function (err, obj)`
     *      - called when the stream is ready, or failed to start
     *      - err {Error} set if an error occured that means the stream cannot
     *        be created
     *      - stop {Function} function to stop the event stream
     * @return vs {VmadmCLIEventStream}
     *      - Can be used to listen for errors, ex: `vs.on('error', ...)`
     */
    events(opts, handler, callback) {
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.uuid, 'opts.uuid');
        assert.optionalString(opts.name, 'opts.name');
        assert.function(handler, 'handler');

        callback(new Error('events not supported'));
    }
}

module.exports = LinuxVmadm;
