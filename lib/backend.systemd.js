/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Generates ephemeral systemd configuration from Machine instances
 */


var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var vasync = require('vasync');

const EventEmitter = require('events');
const { VError } = require('verror');
const { execFile } = require('child_process');

const MACHINECTL = '/usr/bin/machinectl';
const SYSTEMCTL = '/usr/bin/systemctl';

const RUN_DIR = '/run/triton';
const SYSTEMD_DIR = '/run/systemd';

class BackendProp {
    /**
     * @param {string} name - The systemd property name
     * @param {[Object]} opts
     * @param {[*]} opts.default - The type-specific default value.
     * @param {[*[]}} opts.allowed - Array of allowed values.
     * @param {[boolean]} opts.read_only - The property can only be read from
     * systemd.  For instance, the state cannot be set to 'running'.
     * @param {[boolean]} opt.set_once - The property can be set once and not
     * changed.
     * @param {[string]} opt.nspawn_section - The section of a systemd.nspawn
     * file that this is written into.  Default is 'Exec'.  Set sdname to null
     * to prevent this property from being written into an nspawn file.
     * @param {[string]} opt.service_section - The section of a systemd.service
     * file that this is written into.  If not specified or specified as null,
     * the property will not be written to a systemd.service file.
     */
    constructor(backend, name, sdname, opts) {
        assert.object(backend, 'backend');
        assert.string(name, 'name');
        assert.optionalString(sdname, 'sdname');
        assert.optionalObject(opts, 'opts');

        opts = opts || {};
        assert.optionalBool(opts.read_only, 'opts.read_only');
        assert.optionalBool(opts.set_once, 'opts.set_once');
        assert.optionalArray(opts.allowed, 'opts.allowed');
        assert.optionalFunc(opts.get_xform, 'opts.get_xform');

        var self = this;

        // Not implemented by this class; subclasses must implement.
        assert.func(this.validate);

        self.backend = backend;
        self.name = name;
        self.sdname = sdname;
        self.value = undefined;
        self.dirty = false;
        self.read_only = !!opts.read_only;
        self.set_once = !!opts.set_once;
        self.allowed = opts.allowed;
        var sect;

        if (opts.hasOwnProperty('nspawn_section')) {
            sect = opts.nspawn_section;
            if (sect !== null) {
                assert.string(sect, 'opts.npsawn_section');
            }
            self.nspawn_section = sect;
        } else {
            self.nspawn_section = 'Exec';
        }

        if (opts.hasOwnProperty('service_section')) {
            sect = opts.service_section;
            if (sect !== null) {
                assert.string(sect, 'opts.service_section');
            }
            self.service_section = sect;
        }

        if (opts.hasOwnProperty('default')) {
            self.set(opts.default);
        }
    }

    set(value) {
        var self = this;

        if (self.read_only) {
            throw new VError({name: 'ReadOnlyPropertyError', info: self},
                'while trying to set value to %j', value);
        }

        if (self.set_once && self.value !== undefined && self.value !== value) {
            throw new VError({name: 'SetOncePropertyError', info: self},
                'while trying to set value to %j', value);
        }

        if (self.allowed && self.allowed.indexOf(value) === -1) {
            throw new VError({name: 'IllegalValueError', info: self},
                'while trying to set value to %j', value);
        }

        self.validate(value);
        self.value = value;
        self.dirty = true;
        self.initialized = true;
    }

    get() {
        var self = this;

        if (!self.initialized) {
            throw new VError({name: 'UnitializedPropertyError', info: self},
                'unable to get value of "%s"', self.name);
        }
        if (self.get_xform) {
            return self.get_xform(self.backend, self.value);
        }
        return self.value;
    }


    /**
     * Retrieve the information required to populate systemd.nspawn file.
     * @param {[Object]} opts
     * @param {[boolean]} opts.only_dirty - Return a value only if the property
     * has changed since the last time this was called.
     * @returns {[Object]} If the property has a value, an object is returned
     * that contains the nspawn file section, the property name, and the
     * property value (as a string).
     */
    getNspawnProp(opts) {
        assert.optionalObject(opts, 'opts');
        var self = this;

        if (self.sdname === null || !self.initialized) {
            return null;
        }
        if (opts && opts.only_dirty && !self.dirty) {
            return null;
        }

        self.dirty = false;
        return {
            section: self.nspawn_section,
            name: self.sdname,
            value: self.get().toString()
        };
    }

    /**
     * Retrieve the information required to populate systemd.service file, which
     * is also suitable for use with "systemctl set-property"
     * @param {[Object]} opts
     * @param {[boolean]} opts.only_dirty - Return a value only if the property
     * has changed since the last time this was called.
     * @returns {[Object]} If the property has a value, an object is returned
     * that contains the nspawn file section, the property name, and the
     * property value (as a string).
     */
    getServiceProp(opts) {
        assert.optionalObject(opts, 'opts');
        var self = this;

        if (self.sdname === null || !self.initialized) {
            return null;
        }
        if (opts && opts.only_dirty && !self.dirty) {
            return null;
        }

        self.dirty = false;
        return {
            section: self.service_section,
            name: self.sdname,
            value: self.get().toString()
        };
    }
}

/**
 * Base class for various dbus integer types.
 */
class DynPropInteger extends BackendProp {
    // XXX when we start to use node 10+, start using BigInt.
    constructor(backend, name, sdname, opts) {
        super(backend, name, sdname, opts);
    }

    validate(value) {
        assert.strictEqual(value, parseInt(value, 10), 'value is an integer');
        if (value < this.min || this.value > this.max) {
            throw new VError({
                info: {
                    min: this.min,
                    max: this.max,
                    value: value
                },
                name: 'RangeError'
            }, 'value %d out of range [%d, %d]', value, this.min, this.max);
        }
    }
}

/**
 * Unsigned 64-bit value stored via dbus
 * @extends {DynPropInteger}
 */
class Uint64Prop extends DynPropInteger {
    constructor(backend, name, sdname, opts) {
        super(backend, name, sdname, opts);
        this.min = 0;
        this.max = Math.pow(2, 64) - 1;
    }
}

class BoolProp extends BackendProp {
    constructor(backend, name, sdname, opts) {
        super(backend, name, sdname, opts);
    }

    validate(value) {
        assert.bool(value, 'value');
    }
}

class StringProp extends BackendProp {
    constructor(backend, name, sdname, opts) {
        super(backend, name, sdname, opts);
    }

    validate(value) {
        assert.string(value, 'value');
    }
}

class ListProp extends BackendProp {
    constructor(backend, name, sdname, opts) {
        super(backend, name, sdname, opts);
    }

    validate(value) {
        assert.array(value, 'value');
    }
}

class NoProp extends BackendProp {
    constructor(backend, name) {
        super(backend, name, null);
    }

    get() {
        throw new VError({name: 'NoBackendPropertyError', info: this},
            'property "%s" is not supported by the systemd backend', this.name);
    }

    set(_value) {
        throw new VError({name: 'NoBackendPropertyError', info: this},
            'property "%s" is not supported by the systemd backend', this.name);
    }

    validate(_value) {
        throw new VError({name: 'NoBackendPropertyError', info: this},
            'property "%s" is not supported by the systemd backend', this.name);
    }
}


/**
 * Generate a systemd config file from the two-level dictionary.  All keys and
 * leaf values must be strings.
 * @param {Object} obj
 * @param {Object} obj.* - One per section
 * @param {string|string[]} obj.*.* - One per property line in the enclosing
 * section.  Use an array when multiple property lines are needed.  If the first
 * value in the array is an empty string, this will clear all values found in
 * earlier unit files.  See systemd.unit(5).
 */
function to_unit(obj) {
    assert.object(obj, 'obj');

    var section, key;
    var lines = [
        '# DO NOT EDIT!  Use "vmadm update" instead.',
        // XXX-mg find a better URL
        '# For help, see https://github.com/joyent/node-vmadm'
    ];

    for (section in obj) {
        assert.string(section, 'section');
        lines.push(`[${section}]`);
        for (key in obj[section]) {
            assert.string(key, 'key');
            var val = obj[section][key];

            if (typeof val === 'string') {
                lines.push(`${key}=${val}`);
                continue;
            }

            assert.arrayOfString(obj[section][key], 'obj[section][key]');
            var vals = val;
            for (val in vals) {
                val = vals[val];
                lines.push(`${key}=${val}`);
            }
        }
        lines.push('');
    }

    return lines.join('\n');
}

function MainPID_to_pid(_backend, value) {
    // XXX this currently returns the nspawn process, not the init process. Use:
    // machinectl show --property=Leader $uuid
    return value;
}

function SubState_to_state(_backend, value) {
    // XXX need to deal with the case when the machine isn't running.
    return value;
}

/**
 * A systemd backend for creating and managing Machine instances.
 *
 * A machine configuration typically survives reboot by being stored in the
 * Triton native format under /var/triton/vmadm/machines.  This class is
 * responsible for translating from the Triton native format to the systemd
 * native format and for being able to translate the live state to the Triton
 * format.  That is, this code can serve as a building block for a systemd
 * generator and as a watcher for a Linux version of vminfod.
 *
 * Configuration that belongs in systemd and may be dynamically changed is
 * configured via dbus.  Dbus is used because it already provides the APIs
 * required to dynamically change resource controls and to see when many
 * properties systemd-managed containers are changed.  This translates into
 * configuration and updates using the same code path while allowing watchers to
 * get instant notification of configuration and state change that can be
 * reflected up to VMAPI via VM Agent.
 *
 * Configuration that is static includes things like the machine's UUID and
 * its install location.  This data is stored in systemd configuration files
 * under /run/systemd/nspawn and/or /run/systemd/system.  Note that /run is not
 * persisted across reboots.
 *
 * Network configuration is a tricky, as systemd-nspawn offers very
 * little control over how it is set up.  Each nic gets a macvlan instance,
 * which nspawn will configure as mv-<hostinterface><instance>.  The MAC address
 * will be one that is picked by systemd and may not be consistent across
 * reboots.  That's bad because triton APIs rely on a known MAC address for
 * things like update_nics calls.  To cope with this, we first boot the instance
 * to a fake init program.  That fake init program waits to be signaled that it
 * is time to start the real init program.  A ExecStartPost command is used to
 * enter the container's networking namespace and configure the NICs as they
 * should be.  Once that happens, the fake init program is told to start the
 * real init program.  This is roughly equalivalent to the SmartOS method where
 * the zone is readied, networking is set up, then the zone is booted.
 *
 * While it would be possible for the fake init program to do all of the
 * configuration, it is expected that we will want to drop some network
 * configuration capabilities via nspawn so that the container is not able to
 * reconfigure its networking.  Further, various containers may lack the tools
 * required to configure networking.  The helper program run via the
 * BootExecPost hook will run the host's executables within the container's
 * namespace.  That is, it will be using a consistent set of tools to configure
 * networking without relying on any data in the container's file system.
 */
class MachineBackend extends EventEmitter {
    /**
     * @param {UUID} {uuid} - The machine's uuid.
     * @param {Object} opts
     * @param {[Object]} opts.log - A logger, probably from bunyan.  If not,
     * provided, console will be used.
     * @param {[string]} opts.systemd_dir - The top of the systemd hierarchy.
     * Default is '/run/systemd'.
     * @param {[string]} opts.run_dir - The directory that will contain other
     * generated files (e.g. scripts).  Default is '/run/triton';
     */
    constructor(uuid, opts) {
        assert.uuid(uuid, 'uuid');
        assert.object(opts, 'opts');
        assert.object(opts.log, 'opts.log');
        assert.optionalString(opts.systemd_dir, 'opts.systemd_dir');

        super();

        this.log = opts.log || console;
        this.systemd_dir = opts.systemd_dir || SYSTEMD_DIR;
        this.run_dir = opts.run_dir || RUN_DIR;
        this.service = `systemd-nspawn@${uuid}.service`;
        // this.files.*.path: the file name passed to fs.writeFile()
        // this.files.*.options: the options passed to fs.writeFile()
        this.files = {
            service: {
                path: path.join(this.systemd_dir, 'system', this.service),
                options: { mode: 0o644 }
            },
            nspawn: {
                path: path.join(this.systemd_dir, 'nspawn', uuid + '.nspawn'),
                options: { mode: 0o644 }
            },
            netscript: {
                path: path.join(this.run_dir, uuid + '.post'),
                options: { mode: 0o755 }
            },
            machinelink: {
                path: path.join('/var/lib/machines', uuid)
            }
        };

        this.props = {};
        this.sdprops = {};

        // No mapping to systemd or machinectl
        this.addProp(NoProp, 'alias');

        this.addProp(BoolProp, 'autoboot', null, {default: false});

        // Verifies that we only get this brand.
        this.addProp(StringProp, 'brand', null, {allowed: ['lx']});

        this.addProp(Uint64Prop, 'cpu_cap', 'CPUQuota', {
            nspawn_section: null,
            service_section: 'Service'
        });
        this.addProp(Uint64Prop, 'cpu_shares', 'CPUWeight', {
            nspawn_section: null,
            service_section: 'Service'
        });

        // The creation time known to systemd is after the CN booted.  The
        // machine may have been created long before then.
        this.addProp(NoProp, 'create_timestamp');

        // No mapping to systemd.
        this.addProp(NoProp, 'customer_metadata');

        // XXX this is configured from metadata service, right?
        this.addProp(NoProp, 'dns_domain');

        // A triton-only concept
        this.addProp(NoProp, 'do_not_inventory');

        // XXX not yet?
        this.addProp(NoProp, 'firewall_enabled');

        this.addProp(StringProp, 'hostname', 'Hostname');

        // ZFS magic, not specific to a MachineBackend
        this.addProp(NoProp, 'image_uuid');
        this.addProp(NoProp, 'indestructible_zoneroot');

        this.addProp(StringProp, 'init_name', 'Parameters', {
            default: '/sbin/init'
        });

        // No mapping to systemd.
        this.addProp(NoProp, 'internal_metadata');
        this.addProp(NoProp, 'internal_metadata_namespace');

        // If the machine is modified, that will be as a triton config
        // update or it should trigger one.  Thus, last modified time can be
        // reliably retrieved by looking at the triton config file(s) that
        // are not specific to backend.
        this.addProp(NoProp, 'last_modified');

        // XXX maintain_resolvers has not been handled in Machine yet
        // either.  Presumably, if this is or becomes true, the value of
        // resolvers should be dynamically applied to /etc/resolv.conf in
        // the instance.  Not a high priority to support this, probably.
        this.addProp(NoProp, 'maintain_resolvers');

        this.addProp(Uint64Prop, 'max_lwps', 'TasksMax', {
            default: 5120,
            nspawn_section: null,
            service_section: 'Service'
        });
        this.addProp(Uint64Prop, 'max_physical_memory', 'MemoryHigh', {
            nspawn_section: null,
            service_section: 'Service'
        });

        // XXX this should become dynamic.
        this.addProp(ListProp, 'nics', null);

        // No mapping to systemd.
        this.addProp(NoProp, 'owner_uuid');

        // XXX better to get this via `machinectl show --property=Leader $uuid`
        this.addProp(Uint64Prop, 'pid', 'MainPID', {
            read_only: true,
            get_xform: MainPID_to_pid
        });

        // No mapping to systemd.
        this.addProp(NoProp, 'build_timestamp');

        // ZFS magic, not specific to MachineBackend
        this.addProp(NoProp, 'quota');

        // XXX this is configured from metadata service, right?
        this.addProp(NoProp, 'resolvers');

        this.addProp(StringProp, 'state', 'SubState', {
            read_only: true,
            get_xform: SubState_to_state
        });

        // No mapping to systemd.
        this.addProp(NoProp, 'tags');

        this.addProp(StringProp, 'uuid', null, {
            allowed: [ uuid ]
        });

        // ZFS magic, not specific to a MachineBackend
        this.addProp(NoProp, 'zfs_data_compression');
        this.addProp(NoProp, 'zfs_filesystem');
        this.addProp(NoProp, 'zonepath');

        this.addProp(StringProp, 'zpool', null, { write_once: true });
    }

    addProp(type, tname, sname, opts) {
        assert.func(type);
        assert.string(tname);
        assert.optionalString(sname);
        assert.optionalObject(opts);
        var self = this;

        var prop = new type(self, tname, sname, opts);
        self.props[tname] = prop;
        if (sname !== null) {
            self.sdprops[sname] = prop;
        }
    }

    /**
     * Create the systemd configuration for the Machine.
     * @param {object} machprops - Machine properties.
     * @param {function} callback - Will be called with an optional Error.
     */
    generate(callback) {
        assert.func(callback);
        var self = this;

        var nics = self.getProp('nics');
        var networks = [];
        var netscript = [
            '# DO NOT EDIT!  Automatically generated by Triton',
            '',
            'set -xeuo pipefail',
            'export PS4="netscript:\\$LINENO+ "',
            'ip link',
            'ip a'
        ];

        // Generate networks and netscript from the machine's nics
        for (var i in nics) {
            var nic = nics[i];

            // XXX This isn't great if there are multiple NICs with the same
            // tag.  Maybe they should all be bonded together.

            networks.push(nic.nic_tag + '0');

            // XXX This is busted: if there are multiple machine nics from
            // external0, how are they named in the container?
            var mv = `mv-${nic.nic_tag}0`;

            // XXX what about vlan?
            netscript.push(
                '',
                `ip link set dev ${mv} down`,
                `ip link set dev ${mv} name ${nic.name} address ${nic.mac}`,
                `ip link set dev ${nic.name} up`
            );
            for (var ip in nic.ips) {
                ip = nic.ips[ip];
                netscript.push(`ip a add ${ip} dev ${nic.name}`);
            }
        }

        var service = {
            Service: {
                // Specify everything via /run/systemd/nspawn/%i.nspawn.
                ExecStart: [
                    '',
                    '/usr/bin/systemd-nspawn -D /var/lib/machines/%i'
                ],
                // This script will enter the machine's network namespace
                // and execute /run/triton/<uuid>.post.
                ExecStartPost: '/opt/cn-agent/bin/configure-machine %i'
            }
        };

        var nspawn = {
            Exec: {
                // We need a non-standard boot program so that a
                // StartExecPost command can monkey with networking without
                // racing with the real init program.
                Boot: 'off',

                // XXX Drop the ability to reconfigure the network?
                // DropCapability: "cap1 cap2",

                // Do not pollute the host journal with stuff the operator
                // cannot control
                LinkJournal: 'no',

                // Use a UID space so container is not privileged.
                PrivateUsers: 'pick'
            },
            Files: {
                BindReadOnly: '/opt/cn-agent/native:/native'
            },
            Network: {
                Private: 'yes',
                MACVLAN: networks
            }
        };

        for (var machprop in this.props) {
            var prop = this.props[machprop];

            var val = prop.getNspawnProp();
            if (val !== null) {
                if (!nspawn[val.section]) {
                    nspawn[val.section] = {};
                }
                nspawn[val.section][val.name] = val.value;
            }

            val = prop.getServiceProp();
            if (val !== null) {
                if (!service[val.section]) {
                    service[val.section] = {};
                }
                service[val.section][val.name] = val.value;
            }
        }

        var content = {
            netscript: netscript.join('\n'),
            service: to_unit(service),
            nspawn: to_unit(nspawn)
        };

        function writeFiles(next) {
            vasync.forEachParallel({
                func: function generateFile(ftype, writenext) {
                    var file = self.files[ftype].path;
                    var options = self.files[ftype].options;
                    var data = content[ftype];

                    // XXX once node 10 or later is used add the option to  make
                    // this recursive. (Yeah, could add mkdirp now...)
                    fs.mkdir(path.dirname(file), function afterMkdir(err) {
                        if (err && err.code !== 'EEXIST') {
                            writenext(new VError(err,
                                'Cannot create parent directory for "%j"',
                                self.files[ftype]));
                            return;
                        }
                        fs.writeFile(file, data, options,
                            function wrote(err2) {

                            if (err2) {
                                writenext(new VError(err,
                                    'Cannot create file %j',
                                    self.files[ftype]));
                                return;
                            }
                            writenext();
                        });
                    });
                },
                inputs: Object.keys(content)
            }, function afterWrites(err, results) {
                if (err) {
                    next(err);
                    return;
                }
                next();
            });
        }

        vasync.pipeline({
            funcs: [
                // XXX This will remove files in /etc/systemd/*/<service>.d,
                // giving no way to persist overrides.  Is that what we really
                // want?
                function _clean(_, next) { self.clean(next); },
                function _write(_, next) { writeFiles(next); },
                function _link(_, next) {
                    var uuid = self.getProp('uuid');
                    var root = path.join('/', self.getProp('zpool'), uuid,
                        'root');
                    var link = path.join('/var/lib/machines', uuid);
                    fs.symlink(root, link, next);
                },
                function _reload(_, next) { self.reloadAll(next); },
                function _autoboot(_, next) { self.autoboot(next); }
            ]}, callback);
    }

    /**
     * Undo the work done by generate()
     */
    clean(callback) {
        assert.func(callback);
        var self = this;

        vasync.pipeline({
            funcs: [
                function _stop(_, next) { self.stop(next); },
                function _revert(_, next) { self.revert(next); },
                // The previous function cleaned up everything that systemd
                // knows about.  This will catch other files, such as the script
                // that configures nics.
                function _remove(_, next) { self.removeFiles(next); },
                function _reload(_, next) { self.reloadAll(next); }
            ]
        }, callback);
    }

    /**
     * If the machine's autoboot property is set to true, enable and start the
     * machine via its nspawn service.
     */
    autoboot(callback) {
        assert.func(callback);
        var self = this;

        if (self.props.autoboot.value === true) {
            // Use 'systemctl enable --now' so that the relevant symbolic link
            // is made, thereby making it noticable when someone turns off
            // autoboot via '<systemctl|machinectl> disable'.
            self._systemctl(['enable', '--now', self.service], callback);
            return;
        }
        callback();
    }

    /**
     * Remove all unit files, drop-in files, and symbolic links, related to this
     * machine's service from `/run/systemd` and `/etc/systemd`.
     */
    revert(callback) {
        this._systemctl(['revert', this.service], callback);
    }

    removeFiles(callback) {
        assert.func(callback);
        var self = this;

        vasync.forEachParallel({
            func: function remove(ftype, next) {
                var file = self.files[ftype].path;

                fs.unlink(file, function removed(err) {
                    if (err && err.code !== 'ENOENT') {
                        next(err);
                        return;
                    }
                    next();
                });
            },
            inputs: Object.keys(self.files)
        }, callback);
    }

    _systemctl(args, callback) {
        assert.arrayOfString(args);
        assert.func(callback);

        execFile(SYSTEMCTL, args,
            function systemctlDone(err, stdout, stderr) {
                if (err) {
                    callback(new VError(err, '"systemctl %s" failed: %j',
                        args.join(' '), {stdout: stdout, stderr: stderr}));
                    return;
                }
                callback();
            });
    }

    /**
     * Tell systemd to reload all unit files
     */
    reloadAll(callback) {
        assert.func(callback);

        this._systemctl(['daemon-reload'], callback);
    }

    /**
     * Get the value of a property.  Note that not all properties are stored in
     * the backend
     * @param {string} propname - the name of a VMObject property.
     */
    getProp(propname) {
        assert.string(propname);
        var self = this;

        return self.lookupProp(propname).get();
    }

    /**
     * Set a property to the specified value.  This has no runtime impact until
     * apply() or generate() is called.  Properties that are not handled by the
     * backend throw 'NoSuchPropertyError' unless instructed otherwise by
     * opts.ignore_errors.
     * @param {string} propname - the name of a VMObject property
     * @param {*} val - A value appropriate for propname.  Backend-specific
     * checks may be performed, such as integer range checks.  If these checks
     * fail, an Error will be thrown.
     * @param {Object} opts
     * @param {string[]} opts.ignore_errors - a list of verror names to ignore.
     * This may include any of the names listed below in 'throws'.
     * @throws {VError} With name set to one of 'NoSuchPropertyError',
     * 'ReadOnlyPropertyError', 'SetOncePropertyError', or 'IllegalValueError'
     */
    setProp(propname, val, opts) {
        assert.string(propname, 'propname');
        assert.optionalObject(opts);
        opts = opts || {};
        assert.optionalArrayOfString(opts.ignore_errors);
        var self = this;

        try {
            self.lookupProp(propname).set(val);
        } catch (err) {
            if (!opts.ignore_errors || !err.name) {
                throw err;
            }
            if (opts.ignore_errors.indexOf(err.name) === -1 &&
                opts.ignore_errors.indexOf('all') === -1) {
                throw err;
            }
        }
    }

    lookupProp(propname) {
        var self = this;
        var prop = self.props[propname];
        if (!prop) {
            throw new VError({name: 'NoSuchPropertyError', info: self},
                'property "%s" does not exist', propname);
        }
        return prop;
    }

    _machinectl(op, callback) {
        assert.string(op);
        assert.func(callback);
        var self = this;

        execFile(MACHINECTL, [op, self.getProp('uuid')],
            function machinectlDone(err, stdout, stderr) {
                if (err) {
                    callback(new VError({
                        name: 'MachinectlError',
                        cause: err,
                        info: { stdout: stdout, stderr: stderr}
                    }, 'Cannot %s machine %s: %s', op, self.getProp('uuid'),
                        stderr));
                    return;
                }
                callback();
            });
    }

    /**
     * Start the machine
     */
    start(callback) {
        assert.func(callback);

        this._machinectl('start', callback);
    }

    /**
     * Stop the machine
     */
    stop(callback) {
        var self = this;
        assert.func(callback);

        this._machinectl('stop', function _stopped(err) {
            if (err) {
                var uuid = self.getProp('uuid');
                var ok = `Could not kill machine: No machine '${uuid}' known\n`;
                if (VError.info(err).stderr !== ok) {
                    callback(err);
                }
            }
            callback();
        });

    }

    /**
     * Reboot the machine
     */
    reboot(callback) {
        assert.func(callback);

        // XXX does this pick up changes that require a reboot?  Are the nics
        // configured properly after reboot?  Would it be better to stop() then
        // start()?
        this._machinectl('reboot', callback);
    }

    /**
     * Watch the machine, calling callback each time there's a change that
     * affects the Triton configuration or state.
     */
    watch(callback) {
        assert.func(callback);

        /* eslint-disable max-len */

        // When changes are detected, this should do something like:
        // self.emit('PropertiesChanged', { state: 'running', pid: 1234 });
        //
        // Detecting property changes should be as simple as using dbus for
        // PropertiesChanged signals. See
        // https://dbus.freedesktop.org/doc/dbus-api-design.html#interface-propertieso
        // Unfortunately, properties that are of interest do not emit the
        // signal.  That is shown with CPUShares as an example.
        //
        // # uuid=371f18c0-9f73-6e86-94f6-c1cf71188d23
        // # object=/org/freedesktop/systemd1/unit/systemd_2dnspawn_40
        // # object+=${uuid//-/_2d}_2eservice
        // # gdbus introspect --system --dest org.freedesktop.systemd1 \
        //    --object-path $object | grep -B 1 ' CPUShares ='
        //       @org.freedesktop.DBus.Property.EmitsChangedSignal("false")
        //       readonly t CPUShares = 1004;
        //
        // That's too bad.  Instead, we will need to watch for changes to unit
        // and drop-in files, presumably with inotify.  When 'systemctl
        // set-property' is used, it modifies a *.conf file in
        // /run/systemd/system.control/systemd-nspawn@$uuid.service.d/ or the
        // equivalent path under /etc/.  By watching for the creation and
        // removal of such files, we can determine that we need to run
        // 'systemctl show systemd-nspawn@$uuid.service' to get the current
        // value.
        //
        // XXX The order of unit-file creation/removal/modification vs. the
        // change being visible by 'systemctl show' is not yet known.  There is
        // likely to be a race here.
        //
        // XXX autoboot needs to be flipped by 'machinectl enable|disable'.

        /* eslint-enable max-len */

        callback(new VError({ name: 'NotImplementedError' },
            'not able to watch machines yet'));
    }
}

module.exports = MachineBackend;
