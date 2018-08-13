/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018 Joyent, Inc.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const mockfs = require('mock-fs');
const tap = require('tap');
const uuidv1 = require('uuid/v1');

const DummyVmadm = require('../../lib/dummy');
const testutil = require('./testutil');

const SERVER_ROOT = '/test/servers';
const SERVER_UUID = 'a54cf694-4e7d-4fa4-a697-ae949b91a957';


function testSubject() {
    return new DummyVmadm({'serverUuid': SERVER_UUID,
                           'serverRoot': SERVER_ROOT,
                           'log': testutil.createBunyanLogger(tap)
                          });
}


tap.test('DummyVmadm', function (suite) {
    suite.afterEach(mockfs.restore);

    const payloads = {
        'web00': {
            'brand': 'joyent',
            'image_uuid': '643de2c0-672e-11e7-9a3f-ff62fd3708f8',
            'alias': 'web00',
            'hostname': 'web00',
            'max_physical_memory': 512,
            'quota': 20,
            'resolvers': ['8.8.8.8'],
            'nics': [
                {
                    'nic_tag': 'admin',
                    'ip': '10.88.88.52',
                    'netmask': '255.255.255.0',
                    'gateway': '10.88.88.2'
                }
            ]
        },
        'web01': {
            'brand': 'joyent',
            'image_uuid': '643de2c0-672e-11e7-9a3f-ff62fd3708f8',
            'alias': 'web01',
            'hostname': 'web01',
            'max_physical_memory': 512,
            'quota': 20,
            'resolvers': ['8.8.8.8'],
            'nics': [
                {
                    'nic_tag': 'admin',
                    'ip': '10.88.88.53',
                    'netmask': '255.255.255.0',
                    'gateway': '10.88.88.2'
                }
            ]
        },
        'ghost': {
            'do_not_inventory': true,
            'brand': 'joyent',
            'image_uuid': '643de2c0-672e-11e7-9a3f-ff62fd3708f8',
            'alias': 'ghost',
            'hostname': 'ghost',
            'max_physical_memory': 512,
            'quota': 20,
            'resolvers': ['8.8.8.8'],
            'nics': [
                {
                    'nic_tag': 'admin',
                    'ip': '10.88.88.50',
                    'netmask': '255.255.255.0',
                    'gateway': '10.88.88.2'
                }
            ]
        }
    };


    suite.test('init', function (t) {
        t.plan(0);
        mockfs({[SERVER_ROOT]: {}});
        testSubject();
        t.end();
    });

    suite.test('simple create', function (t) {
        mockfs({[path.join(SERVER_ROOT, SERVER_UUID, 'vms')]: {}});
        const vmadm = testSubject();
        t.plan(7);
        vmadm.create(payloads.web00, function onCreate(err, info) {
            t.error(err);
            t.ok(info);
            t.ok(info.uuid);
            const uuid = info.uuid;
            const vmFname = path.join(SERVER_ROOT, SERVER_UUID, 'vms',
                                      uuid + '.json');
            t.ok(fs.existsSync(vmFname));
            fs.readFile(vmFname, 'utf8', function onRead(err2, data) {
                t.error(err2);
                const vm = JSON.parse(data);
                t.equal(payloads.web00.uuid, uuid);
                t.equal(payloads.web00.hostname, vm.hostname);
                t.end();
            });
        });
    });

    suite.test('vm does not exist', function (t) {
        mockfs({[path.join(SERVER_ROOT, SERVER_UUID, 'vms')]: {}});
        const vmadm = testSubject();
        t.plan(2);
        const uuid = uuidv1();
        vmadm.exists({'uuid': uuid}, function onExists(err, exists) {
            t.error(err);
            t.notOk(exists);
            t.end();
        });
    });

    suite.test('create->exists', function (t) {
        mockfs({[path.join(SERVER_ROOT, SERVER_UUID, 'vms')]: {}});
        const vmadm = testSubject();
        t.plan(5);
        vmadm.create(payloads.web01, function onCreate(err, info) {
            t.error(err);
            t.ok(info);
            t.ok(info.uuid);
            const uuid = info.uuid;
            vmadm.exists({'uuid': uuid}, function onExists(err2, exists) {
                t.error(err2);
                t.ok(exists);
                t.end();
            });
        });
    });

    suite.test('create->exists (dni)', function (t) {
        mockfs({[path.join(SERVER_ROOT, SERVER_UUID, 'vms')]: {}});
        const vmadm = testSubject();
        t.plan(7);
        vmadm.create(payloads.ghost, function onCreate(err, info) {
            t.error(err);
            t.ok(info);
            t.ok(info.uuid);
            const uuid = info.uuid;
            vmadm.exists({'uuid': uuid}, function onExists(err2, exists) {
                t.error(err2);
                t.notOk(exists);
                vmadm.exists({'uuid': uuid, include_dni: true},
                             function onExistsGhost(err3, existsGhost) {
                                 t.error(err3);
                                 t.ok(existsGhost);
                                 t.end();
                             });
            });
        });
    });

    suite.test('simple delete', function (t) {
        mockfs({[path.join(SERVER_ROOT, SERVER_UUID, 'vms')]: {}});
        const vmadm = testSubject();
        t.plan(6);
        vmadm.create(payloads.web00, function onCreate(err, info) {
            t.error(err);
            t.ok(info);
            t.ok(info.uuid);
            const uuid = info.uuid;
            vmadm.delete({'uuid': uuid}, function onDelete(err2) {
                t.error(err2);
                vmadm.exists({'uuid': uuid}, function onExists(err3, exists) {
                    t.error(err3);
                    t.notOk(exists);
                    t.end();
                });
            });
        });
    });

    suite.test('empty lookup', function (t) {
        mockfs({[path.join(SERVER_ROOT, SERVER_UUID, 'vms')]: {}});
        const vmadm = testSubject();
        t.plan(3);
        vmadm.lookup({}, {}, function onLookup(lookupErr, vms) {
            t.error(lookupErr);
            t.ok(vms);
            t.equal(vms.length, 0);
            t.done();
        });
    });

    suite.test('multi-create->lookup', function (t) {
        mockfs({[path.join(SERVER_ROOT, SERVER_UUID, 'vms')]: {}});
        const vmadm = testSubject();
        t.plan(10);
        vmadm.create(payloads.web00, function onCreate(err, info) {
            t.error(err);
            t.ok(info);
            t.ok(info.uuid);
            const firstUuid = info.uuid;
            vmadm.create(payloads.web01, function onCreate2(err2, info2) {
                t.error(err2);
                t.ok(info2);
                t.ok(info2.uuid);
                const secondUuid = info2.uuid;
                vmadm.lookup({}, {}, function onLookup(lookupErr, vms) {
                    t.error(lookupErr);
                    t.ok(vms);
                    t.equal(vms.length, 2);
                    const foundUuids = vms.map(function (vm) {
                        return vm.uuid;
                    }).sort();
                    t.same(foundUuids, [firstUuid, secondUuid].sort());
                    t.done();
                });
            });
        });
    });

    suite.end();
});
