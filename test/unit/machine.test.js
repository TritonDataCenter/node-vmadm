/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */
'use strict';

const deepcopy = require('deepcopy');
const mockfs = require('mock-fs');
const sprintf = require('sprintf-js').sprintf;
const tap = require('tap');
const testutil = require('./testutil');
const uuidv4 = require('uuid');
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
        zpool: 'triton'
    })
};

function mkfs(pool, imgs, machs) {
    var fs = {
        '/var/imgadm': {
            'images': {
            }
        },
        '/var/triton': {
            'machines': {}
        },
        '/var/lib/machines': {}
    };
    for (var image in imgs) {
        image = imgs[image];
        fs['/var/imgadm']['images'][`${pool}-${image}.json`] =
            mockfs.file(images[image]);
    }
    for (var machine in machs) {
        machine = machs[machine];
        fs['/var/triton/vmadm']['machines'][`${machine}.json`] =
            mockfs.file(machines[machine]);
    }

    return fs;
}

tap.test('Machine', function (suite) {

    // XXX If this is `suite.afterEach(mockfs.restore)` the last suite.test()
    // requires an extra `t.end()` to avoid a 'not finished' error.
    suite.teardown(mockfs.restore);

    suite.test('Machine constructor minimal payload', function (t) {
        const zpool = 'triton';
        const uuid = uuidv4();
        const image_uuid = i_uuid(1);
        mockfs(mkfs(zpool, [image_uuid], []));

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
            zpool: zpool
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
            zfs_filesystem: `${zpool}/${uuid}`,
            zonepath: `/${zpool}/${uuid}`
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

    suite.test('foo', function (t) {
        t.ok(true, 'looks good');
        t.end();
    });

    suite.end();
});
