/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * An implementation of vmadm using the LXD API.
 *
 * - Best source for the API:
 *      https://github.com/lxc/lxd/blob/master/doc/rest-api.md
 * - All the docs for LXD: https://lxd.readthedocs.io/en/latest/
 * - Helpful article regarding how to interact with the API:
 *      https://ubuntu.com/blog/directly-interacting-with-the-lxd-api
 *
 * Sample usage:
 *
 * ```
 * const LXDAdm = require('./lib/index.lxd.js');
 * var lxd = new LXDAdm({log: console});
 * lxd.subscribe();
 *
 * lxd.create({
 *     alias: "testVm0",
 *     cpu_cap: 75,
 *     cpu_shares: 4,
 *     max_lwps: 2000,
 *     image_uuid: "b789b81c-7261-b971-e45b-904c372b19b9"
 * }, (err, pay) => { console.error(err); console.log(pay);});
 *
 * // Returns:
 * // => { uuid: 'triton-362a5d03-197e-4277-b0e8-cd32ec58d4e2' }
 *
 * lxd.load('triton-362a5d03-197e-4277-b0e8-cd32ec58d4e2', {},
 *     (err, pay) => { console.error(err); console.log(pay);});
 *
 * // Returns the whole {Instance} object
 *
 * // VM/Container lifecycle methods:
 * lxd.start('triton-362a5d03-197e-4277-b0e8-cd32ec58d4e2', {},
 *     (err) => { console.error(err); });
 * lxd.reboot('triton-362a5d03-197e-4277-b0e8-cd32ec58d4e2', {},
 *     (err) => { console.error(err); });
 * lxd.stop('triton-362a5d03-197e-4277-b0e8-cd32ec58d4e2', {},
 *     (err) => { console.error(err); });
 * lxd.delete('triton-362a5d03-197e-4277-b0e8-cd32ec58d4e2', {},
 *     (err) => { console.error(err); });
 *
 * // Instances listing:
 * // All instances, get all fields:
 * lxd.lookup({}, {}, (err, pay) => { console.error(err); console.log(pay);});
 * // All instances, only the specified fields:
 * let fields = ['uuid', 'image_uuid', 'create_timestamp']
 * lxd.lookup({}, {
 *     fields: fields
 * }, (err, pay) => { console.error(err); console.log(pay);});
 * // Just the instances matching the given criteria:
 * lxd.lookup({
 *     state: "running"
 * }, {
 *     fields: fields
 * }, (err, pay) => { console.error(err); console.log(pay);});
 *
 * // Close websocket connection
 * lxd.unsubscribe();
 * ```
 *
 */

const assert = require('assert-plus');
const util = require('util');
const uuidv4 = require('uuid');
const Wreck = require('@hapi/wreck');
const WebSocket = require('ws');

/* eslint-disable max-len */
const UUID_REGEXP = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
/* eslint-enable max-len */

/**
 * These are the properties for a given VM used by Vmadm.
 * @typedef {Object} VMObject
 * @property {string} alias - A friendly name for the machine.
 * @property {boolean} autoboot - Does the machine start when the CN boots?
 * @property {string} brand - Required. Must be 'lx' for this class.
 * @property {int} cpu_cap - Percent of a CPU this machine may use.
 * @property {int} cpu_shares - Relative amount of CPU time.
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
 * These are the equivalent properties for a given container/inst used by LXD.
 * @typedef {Object} LXDObject.
 *
 * @property {String} name. While it can be any string, we'll provide a UUID
 *      during machine creation.
 * @property {String} architecture. Usually 'x86_64'.
 *
 * The following are the key/value namespaces supported:
 * @property {Object} boot
 * @property {Object} environment.* - key/value environment variables to export
 *      to the instance and set on exec.
 * @property {Object} image - copy of the image properties at time of creation.
 * @property {Object} limits
 * @property {Object} nvidia
 * @property {Object} raw
 * @property {Object} security
 * @property {Object} user - storage for user properties, searchable.
 * @property {Object} volatile
 *
 * Of these, we're interested only into those with a direct translation into
 * a Triton's VMADM counterpart, or those which are strictly required to make
 * vmadm work using LXD.
 *
 * @property {Boolean} boot.autostart - Always start the instance with LXD.
 * @property {Object} devices: {}
 * @property {Boolean} ephemeral: false
 * @property {String[]} profiles: [ 'default' ]
 * @property {Boolean} stateful: false
 * @property {String} description: ''
 * @property {String} created_at: '2020-10-14T15:37:50.65585384Z'
 * @property {Object} expanded_config or config with the following properties:
 * @property {String} 'image.architecture': 'amd64'
 * @property {String} 'image.description': Human friendly description  of the
 *     image. Something like 'ubuntu 18.04 LTS amd64 (release) (20200922)'
 * @property {String} 'image.label': 'release'
 * @property {String} 'image.os': 'ubuntu'
 * @property {String} 'image.release': 'bionic'
 * @property {String} 'image.serial': '20200922'
 * @property {String} 'image.type': 'squashfs'
 * @property {String} 'image.version': '18.04'
 * @property {String} 'volatile.base_image' - the hash of the image the
 *     instance has been created from
 *     ('39a93d0b355279d430e8ce21c689aa88515212ee99874276e77f7f31ad7bf810')
 * @property {String} 'volatile.eth0.host_name': 'veth75b5d0d4' -
 *      Network device name on the host
 * @property {String} 'volatile.eth0.hwaddr': '00:16:3e:75:5f:c8' -
 *      Network device MAC address
 * @property {String} 'volatile.last_state.power': 'RUNNING' -
 *      Instance state as of last host shutdown.
 * @property {Object} expanded_devices - with the following sample properties:
 * @property {Object} eth0: { name: 'eth0', network: 'lxdbr0', type: 'nic' }
 * @property {Object} root: { path: '/', pool: 'lxdpool', type: 'disk' } }
 * @property {String} status: 'Running'
 * @property {String} status_code: 103
 * @property {String} last_used_at: '2020-10-19T09:14:53.675500272Z'
 * @property {String} location: 'none'
 * @property {String} type: 'container'
 * @property {String} limits.memory - Percentage of the host's memory or fixed
 *      value in bytes (various suffixes supported)
 * @property {String} limits.cpu - Number or range of CPUs to expose to the
 *      instance.
 * @property {String} limits.cpu.allowance - How much of the CPU can be used.
 *      Can be a percentage.
 * @property {Integer} limits.processes - Maximum number of processes that can
 *      run in the instance.
 * @property {} volatile.\<DEVICE_NAME>.apply_quota -
 *      Disk quota to be applied on next instance start
 * @property {String} user.meta-data - Cloud-init meta-data,
 *      content is appended to seed value
 * @property {String} user.network-config - Cloud-init network-config,
 *      content is used as seed value
 * @property {String} user.network_mode - One of "dhcp" or "link-local".
 *      Used to configure network in supported images
 * @property {String} user.user-data - Cloud-init user-data,
 *      content is used as seed value
 * @property {String} user.vendor-data - Cloud-init vendor-data,
 *      content is used as seed value
 * @property {String} instance_type - To be used as basis for limits on
 *      creation time.
 *      See https://github.com/dustinkirkland/instance-type for the supported
 *      instance types.
 * @property {Object} source - with members `type` (one of "image",
 *      "migration", "copy" or "none") and `alias` or `fingerprint` or
 *      `properties` to univocal identify the image at creation time.
 *
 */

class Instance {
    /*
     * @param {VMObject} opts
     */
    constructor(opts, sysinfo) {
        assert.object(opts, 'opts');
        assert.optionalString(opts.alias, 'opts.alias');
        assert.optionalBool(opts.autoboot, 'opts.autoboot');
        assert.number(opts.cpu_cap, 'opts.cpu_cap');
        assert.number(opts.cpu_shares, 'opts.cpu_shares');
        assert.optionalString(opts.create_timestamp, 'opts.create_timestamp');
        assert.optionalObject(opts.customer_metadata, 'opts.customer_metadata');
        assert.optionalString(opts.dns_domain, 'opts.dns_domain');
        assert.optionalBool(opts.do_not_inventory, 'opts.do_not_inventory');
        assert.optionalBool(opts.firewall_enabled, 'opts.firewall_enabled');
        assert.optionalString(opts.hostname, 'opts.hostname');
        assert.optionalObject(opts.image, 'opts.image');
        assert.string(opts.image_uuid, 'opts.image_uuid');
        assert.optionalBool(opts.indestructible_zoneroot,
            'opts.indestructible_zoneroot');
        assert.optionalString(opts.init_name, 'opts.init_name');
        assert.optionalObject(opts.internal_metadata, 'opts.internal_metadata');
        assert.optionalArrayOfString(opts.internal_metadata_namespaces,
            'opts.internal_metadata_namespaces');
        assert.optionalString(opts.last_modified, 'opts.last_modified');
        assert.number(opts.max_lwps, 'opts.max_lwps');
        assert.optionalNumber(opts.max_physical_memory,
            'opts.max_physical_memory');
        assert.optionalArrayOfObject(opts.nics, 'opts.nics');
        assert.optionalString(opts.owner_uuid, 'opts.owner_uuid');
        assert.optionalNumber(opts.pid, 'opts.pid');
        assert.optionalNumber(opts.quota, 'opts.quota');
        assert.optionalArrayOfString(opts.resolvers, 'opts.resolvers');
        assert.optionalString(opts.state, 'opts.state');
        assert.optionalObject(opts.tags, 'opts.tags');
        assert.optionalString(opts.uuid, 'opts.uuid');
        assert.optionalBool(opts.zfs_data_compression,
            'opts.zfs_data_compression');
        assert.optionalString(opts.zfs_filesystem, 'opts.zfs_filesystem');
        assert.optionalString(opts.zonepath, 'opts.zonepath');
        assert.optionalString(opts.zpool, 'opts.zpool');
        assert.optionalObject(sysinfo, 'sysinfo');

        if (sysinfo) {
            this.sysinfo = sysinfo;
        }

        if (opts.alias) {
            this.alias = opts.alias;
        }
        this.autoboot = true;
        if (typeof (opts.autoboot) !== 'undefined') {
            this.autoboot = opts.autoboot;
        }
        this.brand = 'lx';
        this.cpu_cap = opts.cpu_cap;
        this.cpu_shares = opts.cpu_shares;
        if (opts.create_timestamp) {
            this.create_timestamp = opts.create_timestamp;
        }
        this.customer_metadata = opts.customer_metadata || {};
        if (opts.dns_domain) {
            this.dns_domain = opts.dns_domain;
        }
        this.do_not_inventory = opts.do_not_inventory || false;
        this.firewall_enabled = opts.firewall_enabled || false;
        if (opts.hostname) {
            this.hostname = opts.hostname;
        }
        this.image = opts.image || {
            uuid: this.image_uuid
        };
        this.image_uuid = opts.image_uuid;
        this.indestructible_zoneroot = opts.indestructible_zoneroot || false;
        if (opts.init_name) {
            this.init_name = opts.init_name;
        }
        this.internal_metadata = opts.internal_metadata || {};
        if (opts.internal_metadata_namespaces) {
            this.internal_metadata_namespaces =
                opts.internal_metadata_namespaces;
        }
        if (opts.last_modified) {
            this.last_modified = opts.last_modified;
        }
        this.max_lwps = opts.max_lwps;
        if (opts.max_physical_memory) {
            this.max_physical_memory = opts.max_physical_memory;
        }
        if (opts.nics) {
            this.nics = opts.nics;
        }
        this.owner_uuid = opts.owner_uuid ||
            '00000000-0000-0000-0000-000000000000';
        if (opts.pid) {
            this.pid = opts.pid;
        }
        if (opts.quota) {
            this.quota = opts.quota;
        }
        if (opts.resolvers) {
            this.resolvers = opts.resolvers;
        }
        if (opts.state) {
            this.state = opts.state;
        }
        this.tags = opts.tags || {};
        this.uuid = opts.uuid  ?
            (opts.uuid.startsWith('triton-') ?
                opts.uuid.substr(7) : opts.uuid) :
            uuidv4();
        this.zfs_data_compression = opts.zfs_data_compression || false;
        if (opts.zfs_filesystem) {
            this.zfs_filesystem = opts.zfs_filesystem;
        }
        if (opts.zonepath) {
            this.zonepath = opts.zonepath;
        }
        if (opts.zpool) {
            this.zpool = opts.zpool;
        }

        // Save the original payload - we use a transient javascript property,
        // which will not be visible through iteration (i.e. for when someone
        // calls JSON.stringify - this propery will be hidden).
        Object.defineProperty(this, '__original_payload',
            {value: 'static', writable: true});
        this.__original_payload = Object.assign({}, opts);
        // TODO: This is ugly - special properties should be separated!
        delete this.__original_payload.log;
        delete this.__original_payload.req_id;
    }

    /*
     * @returns {Object[]} Array of device objects
     */
    nicsToDevices() {
        assert.arrayOfObject(this.nics, 'this.nics');
        assert.object(this.sysinfo, 'this.sysinfo');

        var devices = {};
        // We don't know which version of cloud-init will be installed
        // (or really, even *if* it will be installed) so we generate a
        // version 1 network config, which is still supported by all versions
        // of cloud-init.
        var cloudInitNetwork = {
            network: {
                version: 1,
                config: []
            }
        };

        var parentNics = this.sysinfo['Network Interfaces'];

        this.nics.forEach(function mapNicToDevice(nic, i) {
            var devName = 'net' + i;
            var ipConfig;
            var parentName = null;
            assert.string(nic.nic_tag, 'nic.nic_tag');

            Object.keys(parentNics).forEach(function (name) {
                if (parentNics[name]['NIC Names'].indexOf(nic.nic_tag) !== -1) {
                    parentName = name;
                }
            });
            // We should have a valid name here, which whill be a string.
            assert.string(parentName, 'parentName');

            devices[devName] = {
                hwaddr: nic.mac,
                name: devName,
                nictype: 'macvlan',
                parent: parentName,
                type: 'nic',
                // The LXD API needs this to be a string.
                vlan: nic.vlan_id.toString()
            };

            ipConfig = {
                type: 'physical',
                name: devName,
                dhcp4: false,
                mac_address: nic.mac,
                subnets: [
                    {
                        type: 'static',
                        ipv4: true,
                        control: 'auto',
                        address: nic.ip,
                        netmask: nic.netmask
                    }
                ]
            };
            if (nic.primary === true) {
                ipConfig.subnets[0].gateway = nic.gateway;
            }
            cloudInitNetwork.network.config.push(ipConfig);
        });

        // Last is the resolver config
        if (this.resolvers) {
            this.resolvers.forEach(function pushResolvers(r) {
                cloudInitNetwork.network.config.push({
                    type: 'nameserver',
                    address: r
                })
            })
        }

        // TODO: routes

        return ({devices: devices, networkConfig: cloudInitNetwork});
    }

    /*
     * @returns {Object} A vmadm object.
     */
    toVmadm() {
        // Start with the original properties.
        let payload = Object.assign({}, this.__original_payload);
        // Override with the lxd properties - this uses the '...' JS Spread
        // operator to return the assigned object properties as part of a
        // generic JS object.
        Object.assign(payload, { ...this });
        return payload;
    }

    /*
     * @returns {LXDObject} LXDObject
     */
    toLXD() {
        const name = UUID_REGEXP.test(this.uuid) ?
                    'triton-' + this.uuid : this.uuid;
        let payload = {
            name: name,
            architecture: 'x86_64',
            profiles: ['default'],
            ephemeral: false,
            config: {
                'boot.autostart': this.autoboot.toString(),
                'limits.cpu.allowance': this.cpu_cap.toString() + '%',
                'limits.cpu': this.cpu_shares.toString(),
                'limits.processes': this.max_lwps.toString(),
                'user.triton.__original_payload':
                    JSON.stringify(this.__original_payload),
                'user.triton.do_not_inventory':
                    this.do_not_inventory.toString(),
                'user.triton.tags': JSON.stringify(this.tags),
                'user.triton.owner_uuid': this.owner_uuid
            },
            type: 'container',
            source: {
                type: 'image'
            }
        };

        if (this.nics) {
            var networking = this.nicsToDevices();
            assert.object(networking, 'networking');
            payload.devices = networking.devices;
            // Network config needs to be the string `#cloud-config\n` followed
            // by a YAML payload. Lucky for us, YAML is a superset of JSON, so
            // we can just stringify it.
            payload.config['user.network-config'] = '#cloud-config\n' +
                '# generated by Triton\n' +
                JSON.stringify(networking.networkConfig);
        }

        if (this.alias) {
            payload.config['user.triton.alias'] = this.alias;
        }

        if (this.max_physical_memory) {
            payload.config['limits.memory'] =
                String(this.max_physical_memory * 1024 * 1024);
        }

        if (this.quota) {
            payload.config['volatile.root.apply_quota'] =
                util.format('%dGiB', this.quota);
        }

        if (this.create_timestamp) {
            payload.created_at = this.create_timestamp;
        }

        if (this.image.fingerprint) {
            payload.source.fingerprint = this.image.fingerprint;
        } else if (this.image.image_uuid) {
            payload.source.fingerprint = this.image.image_uuid.substr(0, 8);
        } else if (this.image_uuid) {
            payload.source.fingerprint = this.image_uuid.substr(0, 8);
        } else if (this.image.alias) {
            payload.source.alias = this.image.alias;
        } else {
            payload.properties = { ...this.image };
        }

        if (this.customer_metadata) {
            var cm = this.customer_metadata;
            var userData = {};
            // Deal with user-script later
            // if (cm['user-script']) {
            //
            // }
            if (cm.root_authorized_keys) {
                userData.ssh_authorized_keys = cm.root_authorized_keys
                    .replace(/\n+$/, '').split('\n');
            }

            payload.config['user.user-data'] = '#cloud-config\n' +
                JSON.stringify(userData);
        }

        return payload;
    }
}

/*
 * @param {LXDObject} opts
 * @return {Instance} VM Instance object
 */
Instance.fromLxd = function (opts) {
    assert.object(opts, 'opts');
    assert.optionalBool(opts.autostart, 'opts.autostart');
    assert.optionalString(opts.created_at, 'opts.created_at');
    assert.object(opts.config, 'opts.config');
    assert.string(opts.status, 'opts.status');

    var vmadmOpts;

    // instances launched directly with lxc won't have this propery.
    if (opts.config.hasOwnProperty('user.triton.__original_payload')) {
        vmadmOpts = Object.assign({},
            JSON.parse(opts.config['user.triton.__original_payload']));
    } else {
        vmadmOpts = {};
    }

    if (opts.created_at) {
        vmadmOpts.create_timestamp = opts.created_at;
    }
    vmadmOpts.cpu_cap = opts.config['limits.cpu.allowance'] ?
        parseInt(opts.config['limits.cpu.allowance'], 10) : 100;
    vmadmOpts.cpu_shares = opts.config['limits.cpu'] ?
        parseInt(opts.config['limits.cpu'], 10) : 100;

    vmadmOpts.max_lwps = opts.config['limits.processes'] ?
        parseInt(opts.config['limits.processes'], 10) : 2000;
    if (opts.config['limits.memory']) {
        // Convert bytes to MB.
        vmadmOpts.max_physical_memory =
            Math.floor(
                parseInt(opts.config['limits.memory'], 10) / 1024 / 1024);
    }

    vmadmOpts.state = (() => {
        switch (opts.status) {
            case 'Running':
                return 'running';
            case 'Starting':
                return 'provisioning';
            case 'Stopped':
                return 'stopped';
            default:
                return opts.status.toLowerCase();
        }
    })();

    // Save all the image properties so we can figure out how to create a
    // VM if needed.
    vmadmOpts.image = {};

    for (let p in opts.config) {
        if (p.startsWith('image.')) {
            vmadmOpts.image[p.substring(6)] = opts.config[p];
        } else if (p === 'boot.autostart') {
            vmadmOpts['autoboot'] = opts.config[p] === 'true';
        } else if (p === 'volatile.base_image') {
            vmadmOpts.image['fingerprint'] = opts.config['volatile.base_image'];
            let fp = opts.config['volatile.base_image'];
            vmadmOpts.image_uuid = fp.substr(0, 8) + '-' +
                                fp.substr(8, 4) + '-' +
                                fp.substr(12, 4) + '-' +
                                fp.substr(16, 4) + '-' +
                                fp.substr(20, 12);
        } else if (p.startsWith('user.triton.')) {
            let pname = p.substring(12);
            if (pname === '__original_payload') {
                // Do nothing
            } else if (pname === 'do_not_inventory') {
                vmadmOpts[pname] = opts.config[p] === 'true';
            } else if (pname === 'tags') {
                assert.string(opts.config[p], 'opts.config[p] must be string');
                vmadmOpts[pname] = JSON.parse(opts.config[p]);
            } else {
                vmadmOpts[pname] = opts.config[p];
            }
        }
    }

    if (opts.config['volatile.root.apply_quota']) {
        vmadmOpts.quota =
            parseInt(opts.config['volatile.root.apply_quota'], 10);
    }

    if (opts.name) {
        vmadmOpts.uuid = opts.name;
    }

    return new Instance(vmadmOpts);
};

/*
 * We use this many times. Better to deal with everything with a higher-order
 * function than repeatedly across every API call
 *
 * @param {Function} fn - The function to execute and catch error if any
 * @param {Object} log - A logger object instance
 * @param {Function} callback - The same callback we've invoked LXDVmadm
 *  method with.
 * @return {Function} to be called with the desired (...params)
 * (in our case that's usually w/o any params)
 */
const handleErr = (fn, log, callback) => (...params) => {
    fn(...params).catch((err) => {
        if (err.data && err.data.payload &&
            err.data.payload.error) {
            err.message += ` (${err.data.payload.error})`;
        }
        log.error({error: err}, 'Request error: ' +
            `${err.message}`);
        callback(err);
        return;
    });
};

/**
 * Vmadm class using LXD
 */
class LXDVmadm {
    /**
     * Create a Vmadm instance using LXD constructor
     * @param {object} opts - Vmadm constructor parameters
     * @param {object} opts.log - Logger instance. Usually a Bunyan logger
     * instance with the level methods `trace`, `debug`, `info`, `warn`
     * and `error`.
     * @param {boolean} [opts.cachingEnabled] - Cache vms once loaded.
     * @param {string} [opts.configdir] - VM configuration directory
     * @param {object} [opts.sysinfo] - System information
     */
    constructor(opts) {
        assert.object(opts, 'opts');
        assert.object(opts.log, 'opts.log');
        ['trace', 'debug', 'info', 'warn', 'error'].forEach(
            (level) => assert.func(opts.log[level], 'opts.log.' + level)
        );
        assert.optionalBool(opts.cachingEnabled, 'opts.cachingEnabled');
        assert.optionalString(opts.configdir, 'opts.configdir');
        assert.optionalObject(opts.sysinfo, 'opts.sysinfo');

        this.log = opts.log;
        this.sysinfo = (opts.sysinfo) ? opts.sysinfo : {
            'System Type': 'linux',
            'Live Image': '20201014T085432Z'
        };

        this.machConstOpts = {
            log: opts.log,
            configdir: opts.configdir,
            sysconfig: this.sysinfo
        };

        // Avoid repeatedly reloading VMs.
        this.cache = {};
        this.cachingEnabled = opts.cachingEnabled;

        // LXD client
        this.wreckOpts = {
            socketPath: '/var/lib/lxd/unix.socket',
            json: 'force'
        };

        this.ws = null;
        this.operations = {};
        // TODO: Do we want to use eTags?
        this.etags = {};

        this.subscribe();
    }

    clearCache() {
        this.cache = {};
    }

    /**
     * Subscribe to LXD API WebSocket interface using local unix sock
     */
    subscribe() {
        const ws = new WebSocket(
            'ws+unix:///var/lib/lxd/unix.socket:' +
            '/1.0/events?type=operation,lifecycle');

        ws.on('open', () => {
            // Done with initialization here.
            this.log.trace('WEBSOCKET OPEN');
        });
        ws.on('close', (code, reason) => {
            this.log.trace('WebSocket closed with code %d: %s', code, reason);
        });
        ws.on('error', (err) => { this.log.error(err, 'WebSocket Error'); });
        ws.on('upgrade', (_response) => {
            this.log.trace('[WEBSOCKET UPGRADE] ');
        });
        ws.on('message', (data) => {
            // Need to do something with this data here.
            // Maybe suscribe to this event with additional
            // options argument {once: true } ?
            this.log.trace('[WEBSOCKET MESSAGE]: ' + data);
            if (data.type === 'operation') {
                // Set operation value to the latest message associated with
                // that operation:
                this.operations[data.metadata.id] = data;
            }
        });

        this.ws = ws;
    }

    /**
     * Close websocket client created by subscribe()
     */
    unsubscribe() {
        if (this.ws) {
            this.ws.close(0, 'Successfully closed WebSocket client');
        }
    }

    /**
     * Check whether a VM exists or not.
     *
     * @param uuid {String} The VM uuid.
     * @param opts {Object} Options
     * @param opts.log {Object}
     * @param opts.include_dni {Boolean} If true, return VMs that have
     *     do_not_inventory set. default: false.
     * @param callback {Function} `function (err, machine)`. Note that
     *     it's possible both err is null and vmobj is null - meaning the vm
     *     does not exist.
     */
    exists(uuid, opts, callback) {
        assert.string(uuid, 'uuid');
        if (typeof opts === 'function') {
            callback = opts;
            opts = {};
        }
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');
        assert.func(callback, 'callback');


        const log = opts.log || this.log;

        if (!this.cachingEnabled || !this.cache[uuid]) {
            const fetchInst = async () => {
                const name = UUID_REGEXP.test(uuid) ? 'triton-' + uuid : uuid;
                const { res, payload } = await Wreck.get(
                    util.format('/1.0/instances/%s', name),
                    this.wreckOpts);
                // TODO: Review if etag is double quoted
                // etag: '"0640b11f4729971ddeffa45c43..."'
                const machine = Instance.fromLxd(payload.metadata);
                this.etags[uuid] = res.headers.etag;
                if (this.cachingEnabled) {
                    this.cache[uuid] = machine;
                }
                const dni = payload &&
                        payload.metadata &&
                        payload.metadata.config &&
                        payload.metadata.config['user.do_not_inventory'] ===
                            'true';
                if (opts.include_dni && dni) {
                    log.trace({ uuid: uuid },
                        'Machine exists but has do_not_inventory=true');
                    callback(null, false);
                    return;
                }
                log.trace({ uuid: uuid }, 'Machine exists');
                callback(null, machine);
            };

            fetchInst().catch((err) => {
                if (err.output && err.output.statusCode === 404) {
                    delete this.cache[uuid];
                    callback();
                    return;
                }
                log.error({ error: err }, 'Unable to check existence of ' +
                    `${uuid}: ${err.message}`);
                callback(err);
                return;
            });
        } else {
            const machine = this.cache[uuid];
            if (opts.include_dni && machine.do_not_inventory === 'true') {
                log.trace({ uuid: uuid },
                    'Machine exists but has do_not_inventory=true');
                callback();
                return;
            }
            log.trace({ uuid: uuid }, 'Machine exists');
            callback(null, machine);
        }
    }


    /**
     * @callback loadCallback
     * @param {Error} err - present when there's an unhandled error
     * @param {VMObject} machine - The machine we're trying to load by uuid
     */

    /**
     * Get a VM by uuid (LXD API GET /1.0/instances/`$uuid`)
     *
     * @param uuid {String} The VM uuid.
     * @param vmopts {Object} Optional vm options
     * @param opts.fields {Array} Return only the keys give in `fields` array
     * @params opts.include_dni {Boolean} If true, return VMs that have
     * do_not_inventory set. default: false.
     * @param opts.log {Object}
     * @param {loadCallback} callback - `function (err, vm)`
     */
    load(uuid, opts, callback) {
        assert.string(uuid, 'uuid');
        if (!callback) {
            callback = opts;
            opts = {};
        }
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');
        assert.func(callback, 'callback');

        this.exists(uuid, opts, (err, machine) => {
            if (err) {
                callback(err);
                return;
            }
            if (!machine) {
                // NOTE: tooling depends on this matching ': No such zone'
                let notFoundErr = new Error('vmadm load ' + uuid +
                    ' failed: No such zone');
                notFoundErr.restCode = 'VmNotFound';

                callback(notFoundErr);
                return;
            }
            callback(null, machine.toVmadm());
        });
    }

    /**
     * @callback createCallback
     * @param {Error} err - present when there's an unhandled error
     * @param {Object} info - Machine information containing the machine uuid.
     * @param {String} info.uuid - The machine uuid
     */

    /**
     * Create a VM (LXD `POST /1.0/instances`)
     *
     * @param {Object} opts
     * @param {Object} [opts.log]
     * @param {String} [opts.uuid] - The uuid to be assigned to the new VM
     * @param {String} [opts.req_id] - Custom id for the HTTP request.
     * @param {createCallback} callback - `function (err, info)`
     */
    create(opts, callback) {
        assert.object(opts, 'opts');
        assert.optionalString(opts.uuid, 'opts.uuid');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.func(callback, 'callback');


        const log = opts.log || this.log;
        let instOpts = Object.assign({}, opts);

        opts = Object.assign({
            uuid: opts.uuid,
            req_id: opts.req_id
        }, opts);

        log.trace(instOpts, 'creating machine');

        instOpts.uuid = instOpts.uuid || uuidv4();
        delete this.cache[instOpts.uuid];

        let inst = new Instance(instOpts, this.sysinfo);

        const createInst = async () => {
            const { res, payload } = await Wreck.post(
                '/1.0/instances',
                Object.assign({
                    payload: inst.toLXD()
                }, this.wreckOpts));

            this._handleResponse({ res: res, payload: payload }, (err) => {
                if (err) {
                    callback(err);
                    return;
                }

                if (!inst.autoboot) {
                    callback(null, { uuid: inst.uuid });
                    return;
                }

                // Start the instance.
                this._changeState(inst.uuid,
                    Object.assign({action: 'start'}, opts),
                    function _onChangeStateCb(startErr) {
                        if (startErr) {
                            callback(startErr);
                            return;
                        }

                        callback(null, { uuid: inst.uuid });
                    });
            });
        };

        handleErr(createInst, log, callback)();
    }


    /**
     * @callback deleteCallback
     * @param {Error} err - Unhandled error, if any
     */

    /**
     * Destroy a VM with the given uuid (LXD API DELETE /1.0/instances/`$uuid`)
     *
     * @param uuid {String} - UUID of VM to delete
     * @param opts {Object} Options
     * @param [opts.log] {Object}
     * @param [opts.include_dni] - {Boolean} If true, delete VMs that have
     * do_not_inventory set. default: false.
     * @param {deleteCallback} callback `function (err)`
     */
    delete(uuid, opts, callback) {
        assert.string(uuid, 'uuid');
        if (!callback) {
            callback = opts;
            opts = {};
        }
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');
        assert.func(callback, 'callback');
        const log = opts.log || this.log;

        this.exists(uuid, opts, (err, machine) => {
            if (err || !machine) {
                callback(err);
                return;
            }
            const name = UUID_REGEXP.test(uuid) ? 'triton-' + uuid : uuid;
            const DeleteInst = async () => {
                const { res, payload } = await Wreck.delete(
                    util.format('/1.0/instances/%s', name),
                    this.wreckOpts);

                this._handleResponse({ res: res, payload: payload }, callback);
            };

            const StopThenDeleteInst = async () => {
                if (machine.state !== 'running') {
                    DeleteInst();
                    return;
                }

                this.stop(uuid, opts, function _onStopCb(stopErr) {
                    if (stopErr) {
                        callback(stopErr);
                        return;
                    }

                    DeleteInst();
                });
            };

            handleErr(StopThenDeleteInst, log, callback)();
        });
    }

    /**
     * TODO
     *
     * @param uuid {String} UUID of VM
     * @param opts {Object} VMADM update payload
     *      - log {Object}
     *      - include_dni {Boolean} If true, update VMs that have
     *        do_not_inventory set. default: false.
     * @param callback {Function} `function (err)`
     */
    update(uuid, opts, callback) {
        assert.uuid(uuid, 'uuid');
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');
        assert.func(callback, 'callback');
        callback(new Error('NotImplementedError'));
    }

    /**
     * Used internally by {@linkcode reboot}, {@linkcode stop}
     * and {@linkcode start}.
     */
    _changeState(uuid, opts, callback) {
        assert.string(uuid, 'uuid');
        assert.object(opts, 'opts');
        assert.string(opts.action, 'opts.action');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');
        assert.func(callback, 'callback');

        if (['restart', 'start', 'stop'].indexOf(opts.action) === -1) {
            callback(new Error('Invalid Machine Action %s', opts.action));
            return;
        }

        const log = opts.log || this.log;

        this.exists(uuid, opts, (err, machine) => {
            if (err) {
                callback(err);
                return;
            }
            if (!machine) {
                callback(new Error('VM does not exist'));
                return;
            }
            const changeInst = async () => {
            const name = UUID_REGEXP.test(uuid) ? 'triton-' + uuid : uuid;
                const { res, payload } = await Wreck.put(
                    util.format('/1.0/instances/%s/state', name),
                    Object.assign({ payload: {
                        action: opts.action,
                        timeout: 30,
                        force: true,
                        // CRIU not supported in Debian
                        stateful: false
                    }}, this.wreckOpts));

                this._handleResponse({ res: res, payload: payload }, callback);
            };

            handleErr(changeInst, log, callback)();
        });
    }

    /**
     * @callback modifyStateCallback
     * @param {Error} err - present when there's an unhandled error trying to
     * modify VM state.
     */

    /**
     * Reboot a VM (LXD PUT /1.0/instances/state?action=restart)
     *
     * @param uuid {String} UUID of VM
     * @param opts {Object} Options
     * @param [opts.force] {Boolean} Whether to force the reboot.
     * @param [opts.log] {Object}
     * @param [opts.include_dni] {Boolean} If true, reboot VMs that have
     * do_not_inventory set. default: false.
     * @param callback {modifyStateCallback} `function (err)`
     */
    reboot(uuid, opts, callback) {
        this._changeState(uuid, Object.assign({
            action: 'restart'
        }, opts), callback);
    }


    /**
     * Call `vmadm reprovision`.
     *
     * @param opts {Object} VMADM reprovision payload
     *      - log {Object}
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
        assert.func(callback, 'callback');

        callback(new Error('reprovision not supported'));
    }


    /**
     * @callback lookupCallback
     * @param {Error} err - Any unhandled error.
     * @param {[VMObject]} vms - Array of VMs
     */

    /**
     * Get a list of VMs (LXD GET /1.0/instances?filter='...')
     *
     * @param search {Object} - Key/pay values to use for VM searching.
     * @param opts {Object} - General options and VM return format specifics
     * @param [opts.uuid] {String} - The VM uuid if want to load a specific VM
     * @param [opts.log] {Object}
     * @param [opts.fields] {Array} Return only the keys give in
     * `fields` array
     * @param [opts.include_dni] {Boolean} If true, return VMs that have
     * do_not_inventory set. default: false.
     * @param callback {lookupCallback} `function (err, vms)`
     */
    lookup(search, opts, callback) {
        assert.object(search, 'search');
        assert.object(opts, 'opts');
        assert.optionalObject(opts.log, 'opts.log');
        assert.optionalString(opts.req_id, 'opts.req_id');
        assert.optionalBool(opts.include_dni, 'opts.include_dni');
        assert.optionalArray(opts.fields, 'opts.fields');
        assert.func(callback, 'callback');

        if (opts.uuid) {
            this.load(opts.uuid, opts, callback);
            return;
        }

        const log = opts.log || this.log;

        const listInsts = async () => {
            const { res, payload } = await Wreck.get(
                '/1.0/instances?recursion=1',
                this.wreckOpts);

            log.trace('listInsts: %d %s',
                res.statusCode, res.statusMessage);

            if (!payload.metadata.length) {
                callback(null, []);
                return;
            }

            const instances = payload.metadata.map((inst) => {
                return Instance.fromLxd(inst);
            }).filter((inst) => {
                // Cache inst just in case we need it later:
                if (this.cachingEnabled) {
                    this.cache[inst.uuid] = inst;
                }
                // Do not return instances with do_not_inventory set unless
                // we're explicitly told to do so:
                return (!inst.do_not_inventory || opts.include_dni);
            }).filter((inst) => {
                let found = true;
                for (let [k, v] of Object.entries(search)) {
                    if (inst[k] !== v) {
                        found = false;
                        break;
                    }
                }
                return found;
            }).map((inst) => {
                const vmObj = inst.toVmadm();
                if (opts.fields && opts.fields.length) {
                    return opts.fields.reduce((arr, key) => {
                        arr[key] = vmObj[key];
                        return arr;
                    }, {});
                } else {
                    return vmObj;
                }
            });

            callback(null, instances);
        };

        handleErr(listInsts, log, callback)();
    }


    /**
     * Call `vmadm kill <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of VM to kill
     *      - log {Object}
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
        assert.func(callback, 'callback');
        callback(new Error('NotImplementedError'));
    }


    /**
     * Call `vmadm info <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of KVM to run info on
     *      - log {Object}
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
        assert.func(callback, 'callback');

        callback(new Error('info not supported'));
    }


    /**
     * Call `vmadm sysrq <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of KVM to run sysrq on
     *      - log {Object}
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
        assert.func(callback, 'callback');

        callback(new Error('sysrq not supported'));
    }


    /**
     * Call `vmadm create-snapshot <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID VM to snapshot
     *      - log {Object}
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
        assert.func(callback, 'callback');
        callback(new Error('NotImplementedError'));
    }


    /**
     * Call `vmadm rollback-snapshot <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of VM container snapshot to rollback
     *      - log {Object}
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
        assert.func(callback, 'callback');
        callback(new Error('NotImplementedError'));
    }


    /**
     * Call `vmadm delete-snapshot <uuid>`.
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of VM container snapshot to delete
     *      - log {Object}
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
        assert.func(callback, 'callback');
        callback(new Error('NotImplementedError'));
    }


    /**
     * Start a VM (LXD PUT /1.0/instances/state?action=start)
     *
     * @param uuid {String} UUID of VM
     * @param opts {Object} Options
     * @param [opts.log] {Object}
     * @param callback {modifyStateCallback} `function (err)`
     */
    start(uuid, opts, callback) {
        assert.string(uuid, 'uuid');
        if (typeof opts === 'function') {
            callback = opts;
            opts = {};
        }
        this._changeState(uuid, Object.assign({
            action: 'start'
        }, opts), callback);
    }

    /**
     * Stop a VM (LXD PUT /1.0/instances/state?action=stop)
     *
     * @param uuid {String} UUID of VM
     * @param opts {Object} Options
     * @param [opts.force] {Boolean} Whether to force the reboot.
     * @param [opts.log] {Object}
     * @param [opts.include_dni] {Boolean} If true, stop VMs that have
     * do_not_inventory set. default: false.
     * @param callback {modifyStateCallback} `function (err)`
     */
    stop(uuid, opts, callback) {
        // TODO: pass timeout option when given
        this._changeState(uuid, Object.assign({
            action: 'stop'
        }, opts), callback);
    }


    /*
     * Wrapper around `vmadm events -jr [uuid]`
     *
     * @param opts {Object} Options
     *      - uuid {String} UUID of VM to watch, if unset all VMs are watched
     *      - log {Object}
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
        assert.func(handler, 'handler');
        assert.func(callback, 'callback');

        callback(new Error('events not supported'));
    }


    flatten(vmobj, field) {
        // if (vm.hasOwnProperty(field)) {
        return vmobj[field];
    }

    _handleResponse({ res, payload }, callback) {
        this.log.trace({
            httpStatus: res.statusCode,
            id: payload.metadata.id,
            operationStatus: payload.metadata.status_code,
            containers: payload.metadata.resources.containers,
            instances: payload.metadata.resources.instances
        }, 'Handle response');

        const operationId = payload.metadata.id;
        const cleanupFailedOp = (data) => {
            if (data.metadata.status_code > 200) {
                // We don't need to keep this any more:
                delete this.operations[operationId];
                callback(new Error(data.metadata.err));
                return;
            }
        };

        cleanupFailedOp(payload);

        const messageCb = (data) => {

            if (typeof (data) === 'string') {
                data = JSON.parse(data);
            }

            if (!data.metadata.id || (data.metadata.id !== operationId)) {
                return;
            }

            if (data.metadata.status_code > 200) {
                this.ws.removeListener('message', messageCb);
                cleanupFailedOp(data);
            }

            // If the operation is still in progress, let's re-attach
            // the event listener:
            if (data.metadata.status_code < 200) {
                this.ws.once('message', messageCb);
                return;
            }

            // Finally if the operation succeeds, we'll return the uuid:
            delete this.operations[operationId];
            this.ws.removeListener('message', messageCb);
            callback(null);
        };
        // Wait for operation completion:
        // We should already be subscribed to ws events. We care just
        // about our very specific message for a given operation id.
        // If we get a message that confirms completion of such
        // operation, we'll do cleanup and continue:
        this.ws.on('message', messageCb);
    }
}


module.exports = LXDVmadm;
