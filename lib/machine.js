/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * This implements the Machine class for a Linux container.  It aims to be
 * compatible with the 'lx' brand on SmartOS.
 *
 * If other types of machines are added, the intent is that they will become
 * subclasses of the Machine class.  In such a case, factory methods should be
 * added to create new and load existing machines without the callers needing to
 * fret much about brand-specific details.
 *
 * The key interfaces of interest are:
 *
 * Machine class
 *
 * This represents an OS container.  If we start to support Docker or KVM, we
 * will probably want subclasses for those rather than spaghetti code in the
 * Machine class.
 *
 * When creating a new machine, a Machine is typically instantiated with:
 *
 *    var newmach = new Machine({log: bunyan_logger}, vmadm_payload)
 *    newmach.install(...);
 *
 * To boot an existing machine, the following should do the trick:
 *
 *    var mach = new Machine({log: bunyan_logger}, uuid)
 *    mach.generate(...);
 *    mach.start(...);
 *
 * The constructor may be passed a specific MachineBackend instance via
 * opts.backend.  If passed, it needs to be a subclass of or mimic EventEmitter,
 * and support the generate(), clean(), getProp(), setProp(), start(), stop(),
 * reboot(), and watch() methods.
 *
 * Those that instantiate a Machine are likely to call the following methods:
 *
 *  exists()    Determine whether a machine exists.
 *  start()     Boot a machine.
 *  stop()      Shutdown a machine.
 *  reboot()    Reboot a macine.
 *  get()       Get the value of a machine property (e.g. 'autoboot').
 *  set()       Set the value of a machine property.
 *  install()   Clone image, generate backend configuration, boot if autoboot.
 *  uninstall() Uninstall the machine, delete its configuration.
 *  generate()  Generate the native (e.g. systemd) configuration.
 *  getAll()    Get all of the configuration and state.  This includes
 *              customer_metadata, runtime state, etc.
 *
 * When set() is called with a valid property name and value, the value is
 * automatically queued for commit to the configuration and the running
 * instance.
 *
 * A Machine implements the EventEmitter interface and emits the following
 * events:
 *
 *  propchange  The value of one or more properties changed.  This is emitted
 *              after the change is in the running machine and on disk, as
 *              applicable.  That is, 'autoboot' will change the on-disk
 *              configuration but not the running configuration.  However,
 *              'state' may affect only the running configuration.
 *
 * The on-disk configuration is stored in a triton-centric form at
 * /var/triton/vmadm/machines/<uuid>.json.  It exists from shortly after
 * install() starts until shortly before uninstall() completes.  As with
 * smartos, metadata, tags, and routes are stored under /<pool>/<uuid>/config/.
 */

const assert = require('assert-plus');
const deepcopy = require('deepcopy');
const fs = require('fs');
const path = require('path');
const vasync = require('vasync');
const zfs = require('zfs').zfs;

const { MultiError, VError } = require('verror');
const MachineBackend = require('./backend.systemd');
const {
    MachPropArrayOfObjects,
    MachPropArrayOfStrings,
    MachPropBool,
    MachPropDynamic,
    MachPropInteger,
    MachPropISO8601,
    MachPropObject,
    MachPropString,
    MachPropUUID
} = require('./machineprop');


const VMADM_CONFIG_DIR = '/var/triton/vmadm/machines';
// XXX move to /var/triton/imgadm
const IMGADM_CONFIG_DIR = '/var/imgadm/images';

const MAX_CPU_COUNT = 100;
const MAX_CPU_SHARES = 16000;   // XXX-mg verify; different on Linux and SmartOS
const DEF_CPU_SHARES = 100;     // If not defined in package
const DEF_TASKS = 2000;         // Following default for nspawn; zone.maxlwps
const MAX_TASKS = 20000;
const DEF_QUOTA = 10;           // GiB

/**
 * A UUID
 * @type {string} UUID
 */

/**
 * @type {Object} VMObject
 * @property {string} alias - A friendly name for the machine.
 * @property {boolean} autoboot - Does the machine start when the CN boots?
 * @property {string} brand - Required. Must be 'lx' for this class.
 * @property {int} cpu_cap - Percent of a CPU this machine may use.
 * @property {int} cpu_shares - Relative amount of CPU time.  See @
 * @property {ISOTime} create_timestamp - ISO 8601 time at creation. Default is
 *           the time that the constructor is called.
 * @property {Object} customer_metadata - Metadata keys not in the "sdc"
 *           namespace. See https://eng.joyent.com/mdata/datadict.html.
 * @property {string} dns_domain - The value of domain in /etc/hosts.
 * @property {boolean} do_not_inventory - If true, do not report this machine to
 *           the headnode.
 * @property {boolean} firewall_enabled - Should cloud firewall be enabled?
 * @property {string} hostname - The hostname to set in the machine.
 * @property {string} image_uuid - The UUID of the machine image use to install
 *           this machine.
 * @property {boolean} indestructible_zoneroot - When set to true, the machine's
 *           root file system is protected from deletion.
 * @property {string} init_name - The name of the machine's init process.
 * @property {Object} internal_metadata - Key:value pairs for metadata in any
 *           namespace in internal_metadata_namepsaces.  These values are
 *           read-only to the running machine.
 * @property {string[]} internal_metadata_namespaces - The metadata namespaces
 *           that will be read-only to the machine.
 * @property {ISOTime} last_modified - Dynamic. The last time that the machine
 *           configuration changed.
 * @property {int} max_lwps - The maximum number of kernel threads or tasks the
 *           machine may use.
 * @property {int} max_physical_memory - The maximum resident set size, in MiB.
 * @property {Nic[]} nics - Network interfaces.
 * @property {UUID} owner_uuid - The owner of the machine.
 * @property {int} pid - Dynamic. The process ID of the init process.
 * @property {int} quota - Disk space limit, in GiB.
 * @property {string[]} resolvers - IP addresses of up to 6 DNS name servers.
 * @property {string} state - The state of the machine. This value should only
 *           be altered as a side effect of creating, booting, etc. the machine.
 * @property {Object} tags - A key:value mapping of machine tags. See
 *           https://docs.joyent.com/public-cloud/tags-metadata/tags.
 * @property {UUID} uuid - The machine's unique identifier.
 * @property {boolean} zfs_data_compression - The type of compression that
 *           should be used on the machine's storage.  This only affects future
 *           writes.
 * @property {string} zfs_filesystem - Dynamic. The name of the ZFS file system
 *           used by this machine.
 * @property {string} zonepath - Dynamic. The mount point of zfs_filesystem.
 * @property {string} zpool - The name of the ZFS pool containing this machine.
 */

/**
 * Class representing a machine.
 * @class
 * @classdoc This class implements what is required for containers. Subclasses
 * may implement triton-docker containers, KVM virtual machines, firecracker,
 * etc.
 */
class Machine {
    /**
     * @param {Object} opts - Options.
     * @param {Object} opts.log - A logger, implementing debug, warn, and error.
     * @param {Object} [opts.backend] - A MachineBackend.
     * @param {string} [opts.config_dir] - If provided, the directory where the
     * machine's triton configuration is stored.
     * @param {boolean} [opts.strict] - If true, turn warnings into errors.
     * @param {Object} [opts.sysconfig] - A sysconfig object.  This will be the
     * source for default value for zpool and perhaps other properties.
     * @param {VMObject|UUID} mach - Either a vmadm payload for a new machine
     * or the UUID of an existing machine.  It must not contain any dynamic
     * read-only properties.
     * XXX Make backend class configurable? Pass in the backend?
     */
    constructor(opts, mach) {
        assert.object(opts, 'opts');
        assert.object(opts.log, 'opts.log');
        assert.optionalBool(opts.strict, 'opts.strict');
        assert.optionalString(opts.config_dir, 'opts.config_dir');
        assert.optionalObject(opts.backend, 'opts.backend');

        var self = this;
        var obj;

        // XXX This is a little expensive.  We may want to not call it and
        // validate if all we will do is call self.exists() or similar.
        self.init();
        self.log = opts.log;
        self.strict = !!opts.strict;
        self.sysconfig = opts.sysconfig || {};

        if (typeof (mach) === 'string') {
            assert.uuid(mach);
            self.uuid = mach;
            obj = { uuid: mach };
            self.backend = opts.backend || new MachineBackend(obj.uuid, opts);
            self.loaded = false;
        } else {
            assert.object(mach);
            assert.uuid(mach.uuid);
            self.uuid = mach.uuid;
            obj = mach;
            self.backend = opts.backend || new MachineBackend(obj.uuid, opts);
            self.setAllProps({}, obj);
            self.validate();
        }

        self.configfile = path.join(opts.config_dir || VMADM_CONFIG_DIR,
            obj.uuid + '.json');

        self.update = self.notImplemented;
        self.snapshot = self.notImplemented;
        self.rollbackSnapshot = self.notImplemented;
        self.deleteSnapshot = self.notImplemented;
    }

    notImplemented(_opts, callback) {
        callback(new VError({name: 'NotImplementedError'}, 'not implemented'));
    }

    /**
     * Sets all proprties to values in the payload.
     * @param {VMobj} obj - A vmadm (or similar) payload.
     */
    setAllProps(opts, obj) {
        assert.strictEqual(arguments.length, 2,
            'Invalid signature: Machine.setAllProps(opts, obj)');
        assert.object(opts);
        assert.object(obj);
        var self = this;
        var errors = [];
        var firstProps = ['zpool', 'brand', 'uuid'];
        var order = [];
        var name, value;

        // Validation of some properties may depend on others.  For instance, to
        // validate image_uuid, we must first know which zpool we are using.
        for (name in firstProps) {
            name = firstProps[name];
            if (!obj.hasOwnProperty(name)) {
                continue;
            }
            order.push([name, obj[name]]);
        }

        for (name in obj) {
            if (firstProps.indexOf(name) !== -1) {
                continue;
            }
            order.push([name, obj[name]]);
        }

        for (var i in order) {
            [name, value] = order[i];
            var prop = self.props[name];
            if (!prop) {
                var err = new VError({
                    name: 'UnsupportedPropertyError',
                    info: {
                        property: name,
                        payload: obj
                    }
                }, 'unsupported property "%s"', name);
                self.log.error(err, err.message);
                errors.push(err);
                continue;
            }
            prop.set(value);
        }

        if (self.strict && errors.length !== 0) {
            throw new MultiError(errors, 'invalid machine configuration');
        }
        self.loaded = true;
    }

    /**
     * Initializes all properties as MachProp instances.  This is called before
     * assigning values to properties.
     */
    init() {
        var self = this;

        self.tritonConfig = {};
        self.metadata = {};
        self.routes = {};
        self.tags = {};

        self.props = {
            'alias': new MachPropString(self, 'alias', self.tritonConfig, {
                    required: false
                }),
            'autoboot': new MachPropBool(self, 'autoboot', self.tritonConfig, {
                    defval: false
                }),
            'brand': new MachPropString(self, 'brand', self.tritonConfig, {
                    allowed: ['lx'],
                    writable: false
                }),
            // Percent of a cpu: 200 === 2 cpus.
            'cpu_cap': new MachPropInteger(self, 'cpu_cap', self.tritonConfig, {
                    min: 1,
                    max: 100 * MAX_CPU_COUNT,
                    required: false
                }),
            'cpu_shares': new MachPropInteger(self, 'cpu_shares',
                self.tritonConfig, {
                    min: 1,
                    max: MAX_CPU_SHARES,
                    defval: DEF_CPU_SHARES
                }),
            'create_timestamp': new MachPropISO8601(self, 'create_timestamp',
                    self.tritonConfig, {
                    defval: self.nowISO8601.bind(self),
                    writable: false
                }),
            'customer_metadata': new MachPropObject(self, 'customer_metadata',
                    self.metadata, {
                        defval: {},
                        required: false
                    }),
            'dns_domain': new MachPropString(self, 'dns_domain',
                self.tritonConfig, {
                    required: false
                }),
            'do_not_inventory': new MachPropBool(self, 'do_not_inventory',
                self.tritonConfig, {
                required: false
            }),
            'firewall_enabled': new MachPropBool(self, 'firewall_enabled',
                self.tritonConfig, {
                required: false
                // validate: self.checkFirewallAllowed.bind(self)
            }),
            'hostname': new MachPropString(self, 'hostname',
                self.tritonConfig, {
                required: false,
                max: 63
            }),
            'image_uuid': new MachPropUUID(self, 'image_uuid',
                self.tritonConfig, {
                    validate: self.checkImage.bind(self),
                    writable: false,
                    required: false
                }),
            'indestructible_zoneroot': new MachPropBool(self,
                'indestructible_zoneroot', self.tritonConfig, {
                    required: false
                }),
            'init_name': new MachPropString(self, 'init_name',
                self.tritonConfig, {
                    required: false
                }),
            'internal_metadata': new MachPropObject(self, 'internal_metadata',
                self.metadata, {
                    defval: {},
                    required: false
                }),
            'last_modified': new MachPropDynamic(self, 'last_modified', {
                getter: self.getLastModified.bind(self)
            }),
            'max_lwps': new MachPropInteger(self, 'max_lwps',
                self.tritonConfig, {
                min: 1,
                max: MAX_TASKS,
                defval: DEF_TASKS
            }),
            'max_physical_memory': new MachPropInteger(self,
                'max_physical_memory', self.tritonConfig, {
                    // Could be less, but that would not be very usable.
                    min: 32,
                    required: false
                }),
            'nics': new MachPropArrayOfObjects(self, 'nics',
                self.tritonConfig, {
                    defval: [],
                    validate: self.checkNICs.bind(self),
                    required: false
                }),
            'owner_uuid': new MachPropUUID(self, 'owner_uuid',
                self.tritonConfig, {
                defval: '00000000-0000-0000-0000-000000000000'
            }),
            'pid': new MachPropDynamic(self, 'pid', {
                getter: self.getInitPid.bind(self)
            }),
            // Disk quota in GiB
            'quota': new MachPropInteger(self, 'quota', self.tritonConfig, {
                min: 1,
                defval: DEF_QUOTA
                // getter: self.getQuota.bind(self)
            }),
            'resolvers': new MachPropArrayOfStrings(self, 'resolvers',
                self.tritonConfig, {
                max: 6,
                required: false
            }),
            'state': new MachPropString(self, 'state', self.tritonConfig, {
                // Can set on-disk states only.
                allowed: [ 'provisioning', 'configured', 'installed',
                    'deleting'],
                defval: 'provisioning'
                // The getter may return other states, like 'running'.
                // getter: self.getState.bind(self)
            }),
            'tags': new MachPropObject(self, 'tags', self.tags, {
                defval: {},
                // validate: self.checkTags.bind(self),
                required: false
            }),
            'uuid': new MachPropUUID(self, 'uuid', self.tritonConfig, {
                defval: function _getMachineUuid(_prop) {
                    return self.uuid;
                },
                writable: false
            }),
            // Currently on, off, lzjb, gzip, gzip1, ..., gzip9, zle, lz4.  This
            // list may grow in future PIs, so leave it to the success or
            // failure of updateCompression() to determine whether the supplied
            // value was OK.
            'zfs_data_compression': new MachPropString(self,
                'zfs_data_compression', self.tritonConfig, {
                    required: false
                }),
            'zfs_filesystem': new MachPropDynamic(self, 'zfs_filesystem', {
                getter: self.getZfsFilesystem.bind(self)
            }),
            'zonepath': new MachPropDynamic(self, 'zonepath', {
                getter: self.getZonepath.bind(self)
            }),
            'zpool': new MachPropString(self, 'zpool', self.tritonConfig, {
                defval: self.getSystemZpool.bind(self),
                validate: self.zpoolExists.bind(self),
                writable: false
            })
        };
    }

    /**
     * Verifies that all required properties are initialized.  For those that
     * aren't initialized, the value may be set with the defval value or the
     * return from the defval function.
     * @throws {MultiError} If a required property is not set and
     * there is no default value.
     */
    validate(_opts) {
        var self = this;
        var errors = [];

        for (var name in self.props) {
            var prop = self.props[name];

            try {
                prop.validate_default();
            } catch (err) {
                self.log.error(err, 'valid to validate property %s', prop);
                errors.push(err);
            }
        }

        if (self.loaded && errors.length > 0) {
            throw new MultiError(errors);
        }
    }

    /**
     * Determine wither the machine exists.
     * @param {Object} opts
     * @param {[boolean]} opts.need_props - If true, properties are loaded,
     * otherwise just check for the existence of the configuration file.
     * @param {function} callback - Called as callback(Error, <true|false>).
     */
    exists(opts, callback) {
        assert.object(opts, 'opts');
        assert.optionalBool(opts.need_props, 'opts.need_props');
        var self = this;

        // XXX this assumees that we watch for the config file to be deleted and
        // self.loaded becomes false.
        if (opts.need_props && !self.loaded) {
            self.load(opts, function loaded(err, _vmobj) {
                if (err && err.code !== 'ENOENT') {
                    callback(err);
                    return;
                }
                callback(null, !err);
            });
            return;
        }

        fs.stat(self.configfile, function _afterStat(err, stats) {
            if (err) {
                if (err.code !== 'ENOENT') {
                    callback(err);
                    return;
                }
                callback(null, false);
                return;
            }
            callback(null, stats.isFile());
        });
    }


    /**
     * Generate the native configuration.  This can have side effects.  Notably,
     * if autoboot is true, the machine should start assuming the machine is far
     * enough along in its boot process.
     */
    generate(opts, callback) {
        this.backend.generate(opts, callback);
    }

    /**
     * Boot a machine
     */
    start(_opts, callback) {
        assert.strictEqual(arguments.length, 2,
            'Invalid signature: Machine.start(opts, callback)');
        var self = this;

        self.backend.generate(function _onGenerated(err) {
            if (err) {
                callback(err);
                return;
            }
            self.backend.start(callback);
        });
    }

    /**
     * Shut down a machine
     */
    stop(_opts, callback) {
        assert.strictEqual(arguments.length, 2,
            'Invalid signature: Machine.stop(opts, callback)');
        this.backend.stop(callback);
    }

    /**
     * Reboot a machine
     */
    reboot(_opts, callback) {
        assert.strictEqual(arguments.length, 2,
            'Invalid signature: Machine.reboot(opts, callback)');
        this.backend.reboot(callback);
    }

    /**
     * Get the value of a machine property.
     * @param {string} propname - The name of the property.
     */
    get(propname) {
        return this.props[propname].get();
    }

    /**
     * Set the value of a machine property.
     * @param {string} propname - The name of the property.
     * @param {string} value - The new value of the property.
     */
    set(propname, value) {
        this.props[propname].set(value);
    }

    /**
     * A validate() method for image_uuid.
     * @param {MachProp} prop - The machine property object to verify.
     * @param {UUID} value - The image UUID to validate.
     * @throws {BadPropertyValueError}
     */
    checkImage(prop, value) {
        var pool = prop.machine.get('zpool');
        var manifest = path.join(IMGADM_CONFIG_DIR, `${pool}-${value}.json`);
        var json = JSON.parse(fs.readFileSync(manifest));
        var brand = json.manifest.requirements.brand;

        // XXX should check other requirements, propagate reqs.networks up?

        if (brand !== 'lx') {
            throw new VError({
                name: 'BadBrandError',
                info: json
            }, 'image is not an lx brand image');
        }
    }

    /**
     * The default getter for the last_modified property.
     * @param {MachProp} _ - Ingored.
     * @returns {ISOTime}
     */
    getLastModified(_) {
        var self = this;

        // We assume that any updates detected by the backend propagated to an
        // instance of this class (perhaps in another process) which then caused
        // the configuration or metdata file to be rewritten.
        try {
            // XXX maybe take latest of this file and <zonepath>/config/*?
            return fs.statSync(self.configfile).mtime;
        } catch (err) {
            if (err.code !== 'ENOENT') {
                throw new VError(err, 'Unable to get last_modified: %s',
                    err.code);
            }
        }
        return self.nowISO8601();
    }

    /**
     * The default getter for the last_modified property.
     * @param {MachProp} _ - Ingored.
     * @returns {(int|null)}
     */
    getInitPid(_) {
        return this.backend.getInitPid();
    }

    /**
     * The default verify() for nics.
     * @param {MachProp} prop - The machine property object to verify.
     * @param {Object[]} nics - The nics.
     */
    checkNICs(_prop, nics) {
        var errors = [];
        // XXX need To make eslint happy, need "es6: true". But where?
        var allowed = new Set(['gateways', 'ips', 'mac', 'mtu', 'name',
            'network_uuid', 'nic_tag', 'primary', 'vlan_id']);
        var dups = {};
        var uniqfields = ['mac', 'name'];
        var val, i, nic;

        function randomMac() {
            var octects = [];
            for (i = 0; i < 6; i++) {
                octects[i] = Math.floor(Math.random() * 255);
            }
            // Set the local bit (2) and clear the group bit (1).
            octects[0] = (octects[0] | 2) & 0xfe;
            // Convert to mac format.
            var hex = Buffer.from(octects).toString('hex');
            var mac = [];
            for (i = 0; i < hex.length; i += 2) {
                mac.push(hex.substring(i, i + 2));
            }
            return mac.join(':');
        }

        function nextName(idx) {
            for (var inst = idx; inst < idx + 10; inst++) {
                var name = `net${inst}`;
                if (!dups.hasOwnProperty(name)) {
                    return name;
                }
            }
            errors.push(new VError({
                name: 'InternalError',
                info: dups
            }, 'Unable to pick a unique nic name starting from %d', idx));
            return undefined;
        }

        for (var prop in uniqfields) {
            prop = uniqfields[prop];
            dups[prop] = {};
            for (i in nics) {
                nic = nics[i];
                if (!nic.hasOwnProperty(prop)) {
                    continue;
                }
                val = nic[prop];
                if (!dups[prop][val]) {
                    dups[prop][val] = [];
                }
                dups[prop][val].push(nic);
            }
            for (val in dups[prop]) {
                if (dups[prop][val].length !== 1) {
                    errors.push(VError({
                        name: 'DuplicateNicError',
                        info: dups[prop][val]
                    }, 'multiple nics use %s="%s"', prop, val));
                }
            }
        }

        var primary = [];
        for (i in nics) {
            nic = nics[i];
            if (!nic.hasOwnProperty('mac')) {
                nic.mac = randomMac();
            }
            if (!nic.hasOwnProperty('name')) {
                nic.name = nextName(i);
            }
            if (nic.hasOwnProperty('primary')) {
                if (typeof (nic.primary) !== 'boolean') {
                    errors.push(new VError({
                        name: 'TypeError',
                        info: nic
                    }, 'nics[%d].primary has type %s, not boolean', i,
                        typeof (nic.primary)));
                } else if (nic.primary) {
                    primary.push(nic);
                }
            }

            var nprops = Object.keys(nic);
            for (var nprop in nprops) {
                nprop = nprops[nprop];
                if (!allowed.has(nprop)) {
                    errors.push(new VError({
                        name: 'InvalidNicPropertyError',
                        info: nic
                    }, 'nics[%d] has invalid property "%s"', i, nprop));
                }
            }
        }
        if (nics.length !== 0 && primary.length !== 1) {
            if (primary.length === 0 && nics.length === 1) {
                nics[0].primary = true;
            } else {
                errors.push(new VError({
                    name: 'PrimaryNicError',
                    info: primary
                }, 'require exactly 1 primary NIC, %d found', primary.length));
            }
        }

        if (errors.length !== 0) {
            throw new MultiError(errors);
        }
    }

    /**
     * The default getter for the s_filesystem property.
     * @param {MachProp} prop - The property being retrieved.
     * @returns {string}
     */
    getZfsFilesystem(_prop) {
        return path.join(this.get('zpool'), this.get('uuid'));
    }

    /**
     * The default getter for the zonepath property.
     * @param {MachProp} prop - The property being retrieved.
     * @returns {string}
     */
    getZonepath(prop) {
        return path.join('/', this.getZfsFilesystem(prop));
    }

    /**
     * The default verify() for the zpool property.
     * @param {MachProp} prop - The machine property to verify.
     * @param {string} value - The name of the zpool to verify.
     * @throws {BadPropertyValueError}
     */
    zpoolExists(_prop, _value) {
        // XXX-mg
        return true;
    }

    /**
     * The default getter() for the zpool property.
     * @param {MachProp} prop - Ingored.
     * @returns {string} zpool name
     */
    getSystemZpool(_prop) {
        return this.sysconfig.Zpool || 'triton';
    }

    /**
     * Get the current time as an ISOTime.
     * @returns {ISOTime} As created by Date.toISOString(), containing hyphens
     * and colons.  There are no milliseconds.
     */
    nowISO8601() {
        var now = new Date();
        return now.toISOString().split('.')[0] + 'Z';
    }

    /**
     * Install the instance.
     * @param {function} callback - Called as callback(err)
     */
    install(opts, callback) {
        assert.strictEqual(arguments.length, 2,
            'Invalid signature: Machine.install(opts, callback)');
        assert.object(opts, 'opts');
        assert.func(callback);
        var self = this;
        assert(self.loaded, 'configuration must be loaded');
        var pool = self.get('zpool');
        var image = self.get('image_uuid');
        var origin = `${pool}/${image}@final`;
        var ds = self.get('zfs_filesystem');
        var quota = self.get('quota');
        var compression = self.get('zfs_data_compression');
        var args = [ 'clone' ];
        var configdir = path.join(self.get('zonepath'), 'config');

        if (quota) {
            args.push('-o', `quota=${quota}`);
        }
        if (compression) {
            args.push('-o', `compression=${compression}`);
        }
        args.push(origin, ds);

        vasync.pipeline({funcs: [
            function writeConfigProvisioning(_, next) {
                self.set('state', 'provisioning');
                fs.writeFile(self.configfile, JSON.stringify(self.tritonConfig),
                    next);
            },
            // XXX should check image first to be sure it is the right brand.
            function clone(_, next) {
                var cloneprops = {};
                if (quota) {
                    cloneprops.quota = `${quota}G`;
                }
                if (compression) {
                    cloneprops.compression = compression;
                }
                zfs.clone(origin, ds, cloneprops, next);
            },
            // As described in https://smartos.org/bugview/OS-8084, the snapshot
            // created by indestructible_zoneroot causes the blocks that have
            // been written to the dataset since its creation to be trappedd.
            // This means that there is quota space that is used that cannot be
            // reclaimed unless this feature is (perhaps temporarily) turned
            // off.  To avoid that, we create an @install snapshot immediately
            // after cloning.  This snapshot exists primilary as a place to hang
            // the hold needed by indestructible_zoneroot.
            function snap(_, next) {
                zfs.snapshot(`${ds}@install`, next);
            },
            function hold(_, next) {
                if (!self.get('indestructible_zoneroot')) {
                    next();
                    return;
                }
                self.holdDataset(ds, next);
            },
            function mkdir(_, next) {
                fs.mkdir(configdir, { mode: 0o755 }, function mkdirDone(err) {
                    if (err && err.code !== 'EEXIST') {
                        next(err);
                        return;
                    }
                    next();
                });
            },
            function writeMetadata(_, next) {
                fs.writeFile(path.join(configdir, 'metadata.json'),
                    JSON.stringify(self.metadata), next);
            },
            function writeRoutes(_, next) {
                fs.writeFile(path.join(configdir, 'routes.json'),
                    JSON.stringify(self.routes), next);
            },
            function writeTags(_, next) {
                // XXX BUG: this writes '"tags": { }', not '{ }'
                // There's a problem with how the tags property is created.  We
                // don't see this with routes, because that property is not yet
                // implemented
                fs.writeFile(path.join(configdir, 'tags.json'),
                    JSON.stringify(self.tags), next);
            },
            function writeConfigInstalled(_, next) {
                self.set('state', 'installed');
                fs.writeFile(self.configfile, JSON.stringify(self.tritonConfig),
                    next);
            },
            function backendGenerate(_, next) {
                // If autboot=true, this can trigger start().
                self.generate(next);
            }
        ]}, function installDone(err) {
            if (err) {
                callback(new VError({
                    name: 'InstallationFailed',
                    cause: err,
                    info: {
                        config: self.tritonConfig,
                        metadata: self.metadata,
                        routes: self.routes,
                        tags: self.tags
                    }
                }, 'installation failed: %s', err.message));
            }
            callback();
        });
    }

    /**
     * Uninstall a machine by removing its dataset and configuration.
     */
    uninstall(opts, callback) {
        assert.strictEqual(arguments.length, 2,
            'Invalid signature: Machine.install(opts, callback)');
        assert.object(opts, 'opts');
        assert.func(callback, 'callback');
        var self = this;
        var ds = self.get('zfs_filesystem');
        var snap = ds + '@install';

        vasync.pipeline({funcs: [
            function preflightHolds(_, next) {
                // The attempt to destroy the dataset will fail if there is a
                // hold.  This check is just done to improve error handling in
                // the sad path.
                self.isSnapshotHeld(snap, 'do_not_destroy',
                    function isHeld(err, held) {

                    if (err) {
                        next(err);
                        return;
                    }
                    if (held) {
                        next(new VError({
                            name: 'DatasetIsHeldError',
                            info: {
                                opts: opts,
                                snapshot: snap
                            }
                        }, `Cannot uninstall: ${snap} is indestructible`));
                    }
                    next();
                });
            },
            function writeConfigDeleting(_, next) {
                self.set('state', 'deleting');
                fs.writeFile(self.configfile, JSON.stringify(self.tritonConfig),
                    next);
            },
            function cleanBackend(_, next) {
                self.backend.clean(next);
            },
            function destroyDataset(_, next) {
                zfs.destroyAll(ds, next);
            },
            function removeconfig(_, next) {
                fs.unlink(self.configfile, next);
            }
        ]}, callback);
    }

    /**
     * Place a hold on the @install snapshot to make the dataset indestructible.
     * @param {string} dataset - The filesystem or volume that will get the
     * hold.
     * @param {function} callback - Called as callback(err).
     */
    holdDataset(dataset, callback) {
        assert.strictEqual(arguments.length, 2,
            'Invalid signature: Machine.holdDataset(snapshot, callback)');
        var self = this;
        var snap = `${dataset}@install`;
        var reason = 'do_not_destroy';

        self.isSnapshotHeld(snap, reason, function isHeld(err, held) {
            if (err) {
                callback(err);
                return;
            }
            if (held) {
                callback();
                return;
            }
            zfs.hold(snap, reason, callback);
        });
    }

    /**
     * Release a hold on the @install snapshot to make the dataset
     * indestructible.
     * @param {string} dataset - The filesystem or volume that will get the
     * hold.
     * @param {function} callback - Called as callback(err).
     */
    releaseDataset(dataset, callback) {
        assert.strictEqual(arguments.length, 2,
            'Invalid signature: Machine.releaseDataset(snapshot, callback)');
        var self = this;
        var snap = `${dataset}@install`;
        var reason = 'do_not_destroy';

        self.isSnapshotHeld(snap, reason, function isHeld(err, held) {
            if (err) {
                callback(err);
                return;
            }
            if (!held) {
                callback();
                return;
            }
            zfs.releaseHold(snap, reason, callback);
        });
    }

    isSnapshotHeld(snapshot, reason, callback) {
        assert.strictEqual(arguments.length, 3, 'Invalid signature: ' +
            'Machine.isSnapshotHeld(snapshot, reason, callback)');
        zfs.holds(snapshot, reason, function holdsDone(err, holds) {
            if (err) {
                callback(err);
                return;
            }
            var held = (holds.indexOf(reason) !== -1);
            callback(null, held);
        });
    }

    /**
     * Reads the configuration from the running system.
     * @param {Object} opts - Currently no options are used, but opts is passed
     * to the logger, just in case it has a tracing id in it.
     * @param {function} callback - Called as callback(err, vmobj).
     */
    load(opts, callback) {
        assert.strictEqual(arguments.length, 2,
            'Invalid signature: Machine.load(opts, callback)');
        assert.object(opts, 'opts');
        assert.func(callback, 'callback');
        var self = this;
        var cfgs = {
            'tritonConfig': self.configfile,
            'metadata': 'metadata.json',
            'routes': 'routes.json',
            'tags': 'tags.json'
        };
        var failcode = 'VmNotFound';

        function safeParse(cfg, parseCb) {
            var pathname = cfgs[cfg];
            if (!pathname.startsWith('/')) {
                // We can't compute zonepath until when know which pool the
                // machine is in.
                pathname = path.join(self.get('zonepath'), 'config',
                    pathname);
                failcode = 'LoadFailed';
            }
            self.log.info({file: pathname}, 'loading file');
            fs.readFile(pathname, function _readConfig(err, data) {
                var newcfg;
                if (err) {
                    parseCb(err);
                    return;
                }
                try {
                    newcfg = JSON.parse(data);
                } catch (parseErr) {
                    parseCb(new VError({
                        name: 'ConfigParseError',
                        cause: parseErr,
                        info: {
                            cfg: cfg,
                            data: data
                        }
                    }, 'failed to parse %s data: ', cfg, parseErr.message));
                    return;
                }
                // Do not replace self.tritonConfig and friends.  Instead copy
                // new data to them.
                for (var newkey in newcfg) {
                    self[cfg][newkey] = newcfg[newkey];
                }
                parseCb();
            });
        }

        // The various MachProp properties reference self.tritonConfig and
        // friends.  We need to empty these objects rather than replace them.
        for (var cfg in cfgs) {
            for (var key in self[cfg]) {
                delete self[cfg][key];
            }
        }

        var backendProps = {};
        vasync.pipeline({funcs: [
            function parseFiles(_, next) {
                vasync.forEachPipeline({
                    func: safeParse,
                    inputs: Object.keys(cfgs)
                }, next);
            },
            /* XXX
            function loadBackend(_, next) {
                self.backend.getAll(function applyBackEnd(err, obj) {
                    if (err) {
                        next(err);
                        return;
                    }
                    backendProps = obj || {};
                    next();
                });
            },
            */
            // XXX need to generate dynamic properties yet (e.g. last_modified).
            function validate(_, next) {
                try {
                    self.validate();
                } catch (err) {
                    // Err on the side of caution when loading a configuration
                    // from disk.  It could be that it comes from the future
                    // where there are properties that are unknown to the
                    // current version.
                    opts.err = err;
                    self.log.warn(opts, 'Configuration loaded but not valid');
                    delete opts.err;
                    if (self.strict) {
                        next(err);
                        return;
                    }
                }
                next();
            }
        ]}, function loadDone(err) {
            if (err) {
                callback(new VError({
                    name: failcode,
                    restCode: failcode,
                    cause: err,
                    info: {
                        config: self.tritonConfig,
                        metadata: self.metadata,
                        routes: self.routes,
                        tags: self.tags,
                        opts: opts
                    }
                }, 'load failed: %s', err.message));
                return;
            }

            var vmobj = deepcopy(self.tritonConfig);
            for (var prop in backendProps) {
                vmobj[prop] = backendProps[prop];
            }
            vmobj.customer_metadata =
                deepcopy(self.metadata.customer_metadata || {});
            vmobj.internal_metadata =
                deepcopy(self.metadata.internal_metadata || {});
            vmobj.routes = deepcopy(self.routes || {});
            vmobj.tags = deepcopy(self.tags || {});
            self.loaded = true;
            callback(null, vmobj);
        });
    }
}

module.exports = {
    Machine: Machine,
    VMADM_CONFIG_DIR: VMADM_CONFIG_DIR
};
