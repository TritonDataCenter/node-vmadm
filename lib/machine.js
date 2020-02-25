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
 */

const assert = require('assert-plus');
const deepcopy = require('deepcopy');
const fs = require('fs');
const path = require('path');
const sprintf = require('sprintf-js').sprintf;
const vasync = require('vasync');

const { execFile } = require('child_process');
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


const VMADM_CONFIG_DIR = '/var/triton/vmadm/config';
// XXX move to /var/triton/imgadm
const IMGADM_CONFIG_DIR = '/var/imgadm/config';
const ZFS = '/sbin/zfs';

const MAX_CPU_COUNT = 100;
const MAX_CPU_SHARES = 16000;   // XXX-mg verify; different on Linux and SmartOS
const DEF_CPU_SHARES = 100;     // If not defined in package
const DEF_TASKS = 2000;         // Following default for nspawn; zone.maxlwps
const MAX_TASKS = 20000;
const DEF_QUOTA = 10;           // GiB

/**
 * An ISO 8601 time like: 2020-04-01T12:34:56Z
 * @type {string} ISOTime
 */

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
     * @param {Object} opts.log - A logger, implementing debug, warn, and error.
     * @param {boolean} opts.strict - If true, turn warnings into errors.
     * @param {[string]} opts.config_dir - If provided, the directory where the
     * machine's triton configuration is stored.
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

        var self = this;
        var obj;

        // XXX This is a little expensive.  We may want to not call it and
        // validate if all we will do is call self.exists() or similar.
        self.init();
        self.log = opts.log;
        self.strict = !!opts.strict;

        if (typeof (mach) === 'string') {
            assert.uuid(mach);
            obj.uuid = mach;
            self.loaded = false;
        } else {
            assert.object(mach);
            assert.uuid(mach.uuid);
            obj = mach;
            // XXX Maybe this should only be called after the config is first
            // saved.  See exists().
            self.loaded = true;
        }

        self.configfile = path.join(opts.config_dir || VMADM_CONFIG_DIR,
            obj.uuid + '.json');
        self.backend = new MachineBackend(self.uuid, opts);

        self.setAllProps(obj);
        self.validate();
    }

    /**
     * Sets all proprties to values in the payload.
     * @param {VMobj} obj - A vmadm (or similar) payload.
     */
    setAllProps(obj) {
        var self = this;
        var errors = [];

        for (var name in obj) {
            var value = obj[name];
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

    }

    /**
     * Initializes all properties as MachProp instances.  This is called before
     * assigning values to properties.
     */
    init() {
        var self = this;

        self.tritonConfig = {};
        self.metadata = {
            customer_metadata: {},
            internal_metadata: {}
        };
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
                    required: false,
                    trigger: self.updateCPUCap
                }),
            'cpu_shares': new MachPropInteger(self, 'cpu_shares',
                self.tritonConfig, {
                    min: 1,
                    max: MAX_CPU_SHARES,
                    defval: DEF_CPU_SHARES,
                    trigger: self.updateCPUShares
                }),
            'create_timestamp': new MachPropISO8601(self, 'create_timestamp',
                    self.tritonConfig, {
                    defval: self.nowISO8601,
                    writable: false
                }),
            'customer_metadata': new MachPropObject(self, 'customer_metadata',
                    self.metadata.customer_metadata, {
                    required: false,
                    trigger: self.updateCustomerMetadata
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
                required: false,
                validate: self.checkFirewallAllowed
            }),
            'hostname': new MachPropString(self, 'hostname',
                self.tritonConfig, {
                required: false,
                max: 63
            }),
            'image_uuid': new MachPropUUID(self, 'image_uuid',
                self.tritonConfig, {
                    validate: self.checkImage,
                    writable: false,
                    required: false
                }),
            'indestructible_zoneroot': new MachPropBool(self,
                'indestructible_zoneroot', self.tritonConfig, {
                    required: false,
                    trigger: self.updateIndestructibleZoneroot
                }),
            'init_name': new MachPropString(self, 'init_name',
                self.tritonConfig, {
                    required: false
                }),
            'internal_metadata': new MachPropObject(self, 'internal_metadata',
                self.metadata.internal_metadata, {
                required: false
            }),
            'last_modified': new MachPropDynamic(self, 'last_modified', {
                getter: self.getLastModified
            }),
            'max_lwps': new MachPropInteger(self, 'max_lwps',
                self.tritonConfig, {
                min: 1,
                max: MAX_TASKS,
                defval: DEF_TASKS,
                trigger: self.updateIndestructibleZoneroot
            }),
            'max_physical_memory': new MachPropInteger(self,
                'max_physical_memory', self.tritonConfig, {
                    // Could be less, but that would not be very usable.
                    min: 32,
                    required: false
                }),
            'nics': new MachPropArrayOfObjects(self, 'nics',
                self.tritonConfig, {
                    validate: self.checkNICs,
                    trigger: self.updateNICs,
                    required: false
                }),
            'owner_uuid': new MachPropUUID(self, 'owner_uuid',
                self.tritonConfig, {
                defval: '00000000-0000-0000-0000-000000000000'
            }),
            'pid': new MachPropDynamic(self, 'pid', {
                getter: self.getInitPid
            }),
            // Disk quota in GiB
            'quota': new MachPropInteger(self, 'quota', self.tritonConfig, {
                min: 1,
                defval: DEF_QUOTA,
                getter: self.getQuota,
                trigger: self.updateQuota
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
                defval: 'provisioning',
                // The getter may return other states, like 'running'.
                getter: self.getState
            }),
            'tags': new MachPropObject(self, 'tags', self.tags, {
                validate: self.checkTags,
                required: false
            }),
            'uuid': new MachPropUUID(self, 'uuid', self.tritonConfig, {
                defval: self.getNewUUID,
                writable: false
            }),
            // Currently on, off, lzjb, gzip, gzip1, ..., gzip9, zle, lz4.  This
            // list may grow in future PIs, so leave it to the success or
            // failure of updateCompression() to determine whether the supplied
            // value was OK.
            'zfs_data_compression': new MachPropString(self,
                'zfs_data_compression', self.tritonConfig, {
                required: false,
                trigger: self.updateCompression
            }),
            'zfs_filesystem': new MachPropDynamic(self, 'zfs_filesystem', {
                getter: self.getZfsFilesystem
            }),
            'zonepath': new MachPropDynamic(self, 'zonepath', {
                getter: self.getZonepath
            }),
            'zpool': new MachPropString(self, 'zpool', self.tritonConfig, {
                defval: self.getSystemZpool,
                validate: self.zpoolExists,
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
    validate() {
        var self = this;
        var errors = [];

        for (var name in self.props) {
            var prop = self.props[name];

            try {
                prop.validate_default(prop);
            } catch (err) {
                errors.push(err);
            }
        }

        if (errors.length > 0) {
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
        assert.optionalBoolean(opts.need_props, 'opts.need_props');
        var self = this;

        // XXX this assumees that we watch for the config file to be deleted and
        // self.loaded becomes false.
        if (opts.need_props && !self.loaded) {
            self.load(function loaded(err, _vmobj) {
                if (err && err.code !== 'ENOENT') {
                    callback(err);
                }
                callback(null, !err);
                return;
            });
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
    generate(callback) {
        this.backend.generate(callback);
    }

    /**
     * Boot a machine
     */
    start(callback) {
        this.backend.start(callback);
    }

    /**
     * Shut down a machine
     */
    stop(callback) {
        this.backend.stop(callback);
    }

    /**
     * Reboot a machine
     */
    reboot(callback) {
        this.backend.reboot(callback);
    }

    /**
     * Get the value of a machine property.
     * @param {string} propname - The name of the property.
     */
    get(propname) {
        assert(this.loaded);
        return this.props[propname].get();
    }

    /**
     * Set the value of a machine property.
     * @param {string} propname - The name of the property.
     * @param {string} value - The new value of the property.
     */
    set(propname, value) {
        return this.props[propname].set(value);
    }

    /**
     * A validate() method for image_uuid.
     * @param {MachProp} prop - The machine property object to verify.
     * @param {UUID} value - The image UUID to validate.
     * @throws {BadPropertyValueError}
     */
    checkImage(_, value) {
        var manifest = path.join(IMGADM_CONFIG_DIR, value + '.json');
        var json = JSON.parse(fs.readFileSync(manifest));
        var reqs = json.manifest.requirements.brand;

        // XXX should check other requirements, propagate reqs.networks up?

        if (reqs.brand !== 'lx') {
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
        var allowed = new Set('gateways', 'ips', 'mac', 'mtu', 'name',
            'network_uuid', 'nic_tag', 'primary', 'vlan_id');
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
            return octects.map(x => sprintf('%02x', x)).join(':');
        }

        function nextName(idx) {
            for (var inst = idx; inst < idx + 10; inst++) {
                var name = `net${inst}`;
                if (!dups[name].hasOwnItem(name)) {
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
        if (primary.length !== 1) {
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
     * The default getter for the zfs_filesystem property.
     * @param {MachProp} prop - The property being retrieved.
     * @returns {string}
     */
    getZfsFilesystem(prop) {
        return path.join(prop.machine.get('zpool'), prop.machine.get('uuid'));
    }

    /**
     * The default getter for the zfs_zonepath property.
     * @param {MachProp} prop - The property being retrieved.
     * @returns {string}
     */
    getZonepath(prop) {
        // XXX 'this' is a property, not the machine. WTF?
        return path.join('/', prop.machine.getZfsFilesystem(prop));
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
        // XXX from sysinfo
        return 'triton';
    }

    /**
     * Get the current time as an ISOTime.
     * @returns {ISOTime} As created by Date.toISOString(), containing hyphens
     * and colons.
     */
    nowISO8601() {
        var now = new Date();
        return now.toISOString();
    }

    /**
     * Install the instance.
     * @param {function} callback - Called as callback(err)
     */
    install(callback) {
        var self = this;
        var pool = self.get('zpool');
        var image = self.get('image_uuid');
        var origin = `${pool}/${image}@final`;
        var ds = self.get('zfs_filesystem');
        var quota = self.get('quota');
        var compression = self.get('zfs_data_compression');
        var args = [ 'clone' ];
        var configdir = path.join(self.get('zfs_zonepath'), 'config');

        if (quota) {
            args.push('-o', `quota=${quota}`);
        }
        if (compression) {
            args.push('-o', `compression=${compression}`);
        }
        args.push(origin, ds);

        vasync.pipeline({funcs: [
            // XXX should check image first to be sure it is the right brand.
            function clone(_, next) {
                execFile(ZFS, args, next);
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
                execFile(ZFS, ['snapshot', `${ds}@install`], next);
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
                    JSON.toString(self.metadata), next);
            },
            function writeRoutes(_, next) {
                fs.writeFile(path.join(configdir, 'routes.json'),
                    JSON.toString(self.routes), next);
            },
            function writeTags(_, next) {
                fs.writeFile(path.join(configdir, 'tags.json'),
                    JSON.toString(self.tags), next);
            },
            function writeConfig(_, next) {
                fs.writeFile(self.configfile, JSON.toString(self.tritonConfig),
                    next);
            },
            function backendGenerate(_, next) {
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
     * Place a hold on the @install snapshot to make the dataset indestructible.
     * @param {string} dataset - The filesystem or volume that will get the
     * hold.
     * @param {function} callback - Called as callback(err).
     */
    holdDataset(dataset, callback) {
        var self = this;
        var snap = `${dataset}@install`;
        var args = [ 'hold', 'do_not_destroy', snap ];

        self.isSnapshotHeld(snap, 'do_not_destroy', function isHeld(err, held) {
            if (err) {
                callback(err);
                return;
            }
            if (held) {
                callback();
                return;
            }
            execFile(ZFS, args, callback);
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
        var self = this;
        var snap = `${dataset}@install`;
        var args = [ 'hold', '-r', 'do_not_destroy', snap ];

        self.isSnapshotHeld(snap, 'do_not_destroy', function isHeld(err, held) {
            if (err) {
                callback(err);
                return;
            }
            if (!held) {
                callback();
                return;
            }
            execFile(ZFS, args, callback);
        });
    }

    isSnapshotHeld(snapshot, reason, callback) {
        execFile(ZFS, ['holds', '-H', snapshot],
            function holdsDone(err, stdout, stderr) {

            if (err) {
                callback(err);
                return;
            }
            // stdout has lines of tab separated values like:
            // triton/foo@install	blah	Wed Mar 11 14:18 2020
            var held = stdout.split('\n')
                .map(x => x.split('\t')[1])
                .reduce(x => x === reason);
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
        var self = this;
        var configdir = path.join(self.get('zfs_zonepath'), 'config');
        var cfgs = {
            'tritonConfig': self.configfile,
            'metadata': path.join(configdir, 'metadata.json'),
            'routes': path.join(configdir, 'routes.json'),
            'tags': path.join(configdir, 'tags.json')
        };

        function safeParse(cfg, parseCb) {
            var pathname = cfgs[cfg];
            fs.readFile(pathname, function _readConfig(err, data) {
                var newcfg;
                if (err) {
                    parseCb(err);
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

        vasync.pipeline({funcs: [
            function parseFiles(_, next) {
                vasync.forEachParallel({
                    funcs: safeParse,
                    inputs: Object.keys(cfgs)
                }, next);
            },
            function loadBackend(_, next) {
                self.backend.load(next);
            },
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
                    name: 'LoadFailed',
                    cause: err,
                    info: {
                        config: self.tritonConfig,
                        metadata: self.metadata,
                        routes: self.routes,
                        tags: self.tags,
                        opts: opts
                    }
                }, 'load failed: %s', err.message));
            }

            var vmobj = deepcopy(self.tritonConfig);
            vmobj.metadata = deepcopy(self.metadata);
            vmobj.routes = deepcopy(self.routes);
            vmobj.tags = deepcopy(self.tags);
            self.loaded = true;
            callback(null, vmobj);
        });
    }
}

module.exports = {
    Machine: Machine,
    VMADM_CONFIG_DIR: VMADM_CONFIG_DIR
};
