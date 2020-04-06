/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */
'use strict';

const mockery = require('mockery');
mockery.enable({
    warnOnReplace: true,
    warnOnUnregistered: false,
    useCleanCache: false
});
const mockzfs = require('../../node_modules/zfs/lib/mock-zfs.js');
mockery.registerMock('zfs', mockzfs);
const zfsmod = require('zfs');
const zfs = zfsmod.zfs;
const zpool = zfsmod.zpool;

const deepcopy = require('deepcopy');
const fs = require('fs');
const mockds = require('../../node_modules/zfs/lib/mock-dataset.js');
const mockfs = require('mock-fs');
const path = require('path');
const sprintf = require('sprintf-js').sprintf;
const tap = require('tap');
const testutil = require('./testutil');
const uuidv4 = require('uuid');
const vasync = require('vasync');
const { Machine } = require('../../lib/machine');

class DummyBackend {
    constructor(uuid, opts) {
        this.uuid = uuid;
        this.opts = opts;
        this.vals = {};
    }

    generate(callback) {
        callback(this.opts.generate_error);
    }

    clean(callback) {
        callback(this.opts.clean_error);
    }

    getProp(propname) {
        if (this.opts.get_error) {
            throw this.opts.get_error;
        }
        return this.vals[propname];
    }

    setProp(propname, value) {
        if (this.opts.set_error) {
            throw this.opts.set_error;
        }
        this.vals[propname] = value;
    }

    start(callback) {
        callback(this.opts.start_error);
    }

    stop(callback) {
        callback(this.opts.stop_error);
    }

    reboot(callback) {
        callback(this.opts.reboot_error);
    }

    watch(callback) {
        callback(this.opts.watch_error);
    }
}

function i_uuid(num) {
    return sprintf('00000000-0000-0000-%04d-000000000000', num);
}

function m_uuid(num) {
    return sprintf('00000000-0000-0000-0000-00000000%04d', num);
}

// For testing, image uuids are non-zero only in second to last grouping
var images = {};
images[i_uuid(1)] = {
    content: JSON.stringify({
        'manifest': {
            'v': 2,
            'uuid': i_uuid(1),
            'owner': '00000000-0000-0000-0000-000000000000',
            'name': 'debian-9',
            'version': '20180404',
            'state': 'active',
            'disabled': false,
            'public': true,
            'published_at': '2018-04-04T15:28:29Z',
            'type': 'lx-dataset',
            'os': 'linux',
            'files': [
                {
                    'sha1': 'da229a383d2dcb2117cf378bb128f7e2c5f8956f',
                    'size': 147332149,
                    'compression': 'gzip'
                }
            ],
            'description': 'Container-native Debian 9.4 (stretch) ...',
            'homepage': 'https://docs.joyent.com/images/...',
            'requirements': {
                'networks': [
                    {
                        'name': 'net0',
                        'description': 'public'
                    }
                ],
                'min_platform': {
                    '7.0': '20171012T005133Z'
                },
                'brand': 'lx'
            },
            'tags': {
                'role': 'os',
                'kernel_version': '4.10'
            }
        },
        'zpool': 'triton',
        'source': 'https://images.joyent.com'
    })
};

// For testing, machine uuids are non-zero only in last grouping.
var machines = {};
machines[m_uuid(1)] = {
    content: JSON.stringify({
        uuid: m_uuid(1),
        brand: 'lx',
        image_uuid: i_uuid(1),
        zpool: syspool
    })
};

function mkfs(pool, imgs, machs) {
    var fs = {
        '/var/imgadm': {
            'images': {
            }
        },
        '/var/triton': {
            'vmadm': {
                'machines': {}
            }
        },
        '/var/lib/machines': {},
        '/etc/systemd': {
            'network': {},
            'nspawn': {},
            'system': {},
            'system.control': {}
        },
        '/run/systemd': {
            'network': {},
            'nspawn': {},
            'system': {},
            'system.control': {}
        }
    };
    fs['/' + pool] = {};
    for (var image in imgs) {
        image = imgs[image];
        fs['/var/imgadm']['images'][`${pool}-${image}.json`] =
            mockfs.file(images[image]);
    }

    return fs;
}

function mkimage(pool, imgs, image, callback) {
    var dsname = path.join(pool, image);
    var snapname = dsname + '@final';
    var mntpt = '/' + dsname;

    vasync.waterfall([
        function createDs(next) {
            zfs.create(dsname, next);
        },
        function createRootDir(next) {
            fs.mkdir(path.join(mntpt, 'root'), next);
        },
        function createCoresDir(next) {
            fs.mkdir(path.join(mntpt, 'cores'), next);
        },
        function snap(next) {
            zfs.snapshot(snapname, next);
        }
    ], callback);
}

var syspool = 'testpool';

tap.test('Machine', function (suite) {
    suite.beforeEach(function (done, t) {
        mockfs(mkfs(syspool, [i_uuid(1)], []));
        zpool.create(syspool, null, done);
    });

    suite.afterEach(function (done) {
        mockds.reset();
        mockfs.restore();
        done();
    });

    suite.test('Machine constructor minimal payload', function (t) {
        const uuid = uuidv4();
        const image_uuid = i_uuid(1);

        var opts = {
            log: testutil.createBunyanLogger(tap),
            backend: new DummyBackend(uuid, {})
        };
        var mach;
        var prop;

        var payload1 = {
            uuid: uuid,
            brand: 'lx',
            image_uuid: image_uuid,
            zpool: syspool
        };

        var payload = deepcopy(payload1);
        mach = new Machine(opts, payload);
        t.strictSame(payload, payload1, 'payload not modified');
        for (prop in payload) {
            t.strictSame(mach.get(prop), payload[prop],
                `payload.${prop} preserved`);
        }
        var props = {
            internal_metadata: {},
            customer_metadata: {},
            nics: [],
            tags: {},
            cpu_shares: 100,        // DEF_CPUSHARES
            max_lwps: 2000,         // DEF_TASKS
            owner_uuid: '00000000-0000-0000-0000-000000000000',
            state: 'provisioning',
            zfs_filesystem: `${syspool}/${uuid}`,
            zonepath: `/${syspool}/${uuid}`
        };

        for (prop in props) {
            t.strictSame(mach.get(prop), props[prop],
                sprintf('payload.%s=%j automatically set', prop, props[prop]));
        }

        // create_timestamp is rounded down to the nearest second.  If it was at
        // 999 ms when created, the time now may be a bit more than 1 second
        // after the rounded down time.  Let's just be sure it's less than 2
        // seconds.
        var now = Date.now();
        var then = Date.parse(mach.get('create_timestamp'));
        t.ok(now > then, 'current time is later than create_timestamp');
        t.ok((now - then) < 2000,
            'create_timestamp is less than 2 seconds ago');
        t.end();
    });

    suite.test('Machine.create', function (t) {
        var image_uuid = i_uuid(1);
        var mach_uuid = uuidv4();
        var payload = {
            uuid: mach_uuid,
            brand: 'lx',
            image_uuid: image_uuid,
            customer_metadata: { foo: 'bar' },
            zpool: syspool
        };
        var opts = {
            log: testutil.createBunyanLogger(tap),
            backend: new DummyBackend(mach_uuid, {})
        };

        var mach;
        vasync.waterfall([
            function createImage(next) {
                mkimage(syspool, images, image_uuid, next);
            }, function initMachine(next) {
                t.doesNotThrow(function () {
                    mach = new Machine(opts, payload);
                }, 'create machine in memory');
                t.ok(mach, 'constructor returned a machine');
                if (!mach) {
                    t.bailout('no machine, skip rest of tests');
                }
                next();
            }, function noConfig(next) {
                var md_dir = path.join(mach.configfile, 'config');
                t.throws(function nocfg() { fs.lstatSync(mach.configfile); },
                    'configfile does not exist');
                t.throws(function nomd() {
                    fs.lstatSync(path.join(md_dir, 'metadata.json'));
                }, 'metadata.json does not exist');
                t.throws(function notags() {
                    fs.lstatSync(path.join(md_dir, 'tags.json'));
                }, 'tags.json does not exist');
                t.throws(function noroutes() {
                    fs.lstatSync(path.join(md_dir, 'routes.json'));
                }, 'routes.json does not exist');
                next();
            }, function install(next) {
                mach.install({}, function (err) {
                    t.error(err, 'installation succeeded');
                    next(err);
                });
            }, function readConfig(next) {
                fs.readFile(mach.configfile, function checkConfig(err, data) {
                    t.error(err, 'read ' + mach.configfile);
                    if (!err) {
                        var config = JSON.parse(data);
                        t.equal(config.uuid, mach_uuid,
                            'the config is for this machine');
                        t.equal(config.image_uuid, image_uuid,
                            'the config is for this machine');
                        t.ok(!config.hasOwnProperty('customer_metadata'),
                            'customer_metadata is not in config file');
                        t.ok(!config.hasOwnProperty('tags'),
                            'tags is not in config file');
                        t.ok(!config.hasOwnProperty('routes'),
                            'routes is not in config file');
                    }
                    next(err);
                });
            }, function readMetadata(next) {
                var file = path.join(mach.get('zonepath'),
                    'config/metadata.json');
                var exp_cfg = {
                    'customer_metadata': payload.customer_metadata,
                    'internal_metadata': {}
                };
                fs.readFile(file, function checkConfig(err, data) {
                    t.error(err, 'read ' + mach.configfile);
                    if (!err) {
                        var config = JSON.parse(data);
                        t.same(config, exp_cfg, 'metadata.json is as expected');
                    }
                    next(err);
                });
            }, function readTags(next) {
                var file = path.join(mach.get('zonepath'), 'config/tags.json');
                var exp_cfg = { };
                fs.readFile(file, function checkConfig(err, data) {
                    t.error(err, 'read ' + mach.configfile);
                    if (!err) {
                        var config = JSON.parse(data.toString());
                        // XXX a known failure.  See machine.js comment.
                        t.same(config, exp_cfg, 'tags.json is as expected');
                    }
                    next(err);
                });
            }, function readRoutes(next) {
                var file = path.join(mach.get('zonepath'),
                    'config/routes.json');
                var exp_cfg = { };
                fs.readFile(file, function checkConfig(err, data) {
                    t.error(err, 'read ' + mach.configfile);
                    if (!err) {
                        var config = JSON.parse(data.toString());
                        t.same(config, exp_cfg, 'routes.json is as expected');
                    }
                    next(err);
                });
            }
        ], function (err) {
            t.error(err, 'installation succeeded');
            t.end();
        });
    });

    suite.end();
});
