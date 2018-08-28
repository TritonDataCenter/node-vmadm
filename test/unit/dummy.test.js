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
const os = require('os');
const path = require('path');

const fse = require('fs-extra');
const mockfs = require('mock-fs');
const tap = require('tap');
const uuidv1 = require('uuid/v1');
const vasync = require('vasync');

const DummyVmadm = require('../../lib/index.dummy');
const testutil = require('./testutil');

const SERVER_ROOT = '/test/servers';
const SERVER_UUID = 'a54cf694-4e7d-4fa4-a697-ae949b91a957';


function testSubject(serverRoot) {
    return new DummyVmadm({
        log: testutil.createBunyanLogger(tap),
        serverRoot: serverRoot,
        serverUuid: SERVER_UUID,
        sysinfo: {
            'Datacenter Name': 'testdc',
            'Live Image': '20180806T115631Z',
            'UUID': SERVER_UUID
        }
    });
}

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


tap.test('DummyVmadm', function (suite) {
    suite.afterEach(mockfs.restore);

    suite.test('init', function (t) {
        t.plan(0);
        mockfs({[SERVER_ROOT]: {}});
        testSubject();
        t.end();
    });

    suite.test('simple create', function (t) {
        mockfs({[path.join(SERVER_ROOT, SERVER_UUID, 'vms')]: {}});
        const vmadm = testSubject(SERVER_ROOT);
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
        const vmadm = testSubject(SERVER_ROOT);
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
        const vmadm = testSubject(SERVER_ROOT);
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
        const vmadm = testSubject(SERVER_ROOT);
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
        const vmadm = testSubject(SERVER_ROOT);
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
        const vmadm = testSubject(SERVER_ROOT);
        t.plan(3);
        vmadm.lookup({}, {}, function onLookup(lookupErr, vms) {
            t.error(lookupErr);
            t.ok(vms);
            t.equal(vms.length, 0);
            t.end();
        });
    });

    suite.test('multi-create->lookup', function (t) {
        mockfs({[path.join(SERVER_ROOT, SERVER_UUID, 'vms')]: {}});
        const vmadm = testSubject(SERVER_ROOT);
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
                    t.end();
                });
            });
        });
    });

    suite.test('stop', function (t) {
        mockfs({[path.join(SERVER_ROOT, SERVER_UUID, 'vms')]: {}});
        const vmadm = testSubject(SERVER_ROOT);
        t.plan(6);
        vmadm.create(payloads.web00, function onCreate(err, info) {
            t.error(err);
            // Is the initial state part of the contract, or an implementation
            // detail?
            t.notEqual(info.state, 'stopped');
            const uuid = info.uuid;
            vmadm.stop({'uuid': uuid}, function onStop(err2) {
                t.error(err2);
                vmadm.load({'uuid': uuid}, function onLoad(err3, vm) {
                    t.error(err3);
                    t.ok(vm);
                    t.equal(vm.state, 'stopped');
                    t.end();
                });
            });
        });
    });

    suite.test('stop->start', function (t) {
        mockfs({[path.join(SERVER_ROOT, SERVER_UUID, 'vms')]: {}});
        const vmadm = testSubject(SERVER_ROOT);
        t.plan(10);
        vmadm.create(payloads.web00, function onCreate(err, info) {
            t.error(err);
            // Is the initial state part of the contract, or an implementation
            // detail?
            t.notEqual(info.state, 'stopped');
            const uuid = info.uuid;
            vmadm.stop({'uuid': uuid}, function onStop(err2) {
                t.error(err2);
                vmadm.load({'uuid': uuid}, function onLoad(err3, vm) {
                    t.error(err3);
                    t.ok(vm);
                    t.equal(vm.state, 'stopped');
                    vmadm.start({'uuid': uuid}, function onStart(err4) {
                        t.error(err4);
                        vmadm.load({'uuid': uuid},
                                   function onReload(err5, vmAgain) {
                                       t.error(err5);
                                       t.ok(vmAgain);
                                       t.equal(vmAgain.state, 'running');
                                       t.end();
                                   });
                    });
                });
            });
        });
    });


    // reboot (need events to test?
    suite.end();
});

// No mock-fs support for fs.watch:
//   https://github.com/tschaub/mock-fs/issues/246
tap.test('DummyVmadmRealFs', function (suite) {
    // Serialize these tests since they use the real fs
    suite.jobs = 1;
    const testDir = path.join(os.tmpdir(), SERVER_ROOT, SERVER_UUID, 'vms');
    suite.beforeEach(function (cb) {
        fse.emptyDir(testDir, cb);
    });
    // Why does this make everything explode?
    // suite.afterEach(function(cb) {
    //     fse.remove(testDir, cb);
    // });

    suite.test('events-ready', function (t) {
        const vmadm = testSubject(path.join(os.tmpdir(), SERVER_ROOT));
        t.plan(2);
        vmadm.events({name: 'unit-test:events-ready'},
                     function handler() {},
                     function vmadmEventsReady(err, obj) {
                         t.error(err);
                         t.ok(obj);
                         obj.stop();
                         t.end();
                     });
    });

    suite.test('events->create', function (t) {
        const vmadm = testSubject(path.join(os.tmpdir(), SERVER_ROOT));
        t.plan(8);

        // TODO: Is this really what we call it?
        let streamStop = null;
        let uuid = null;
        vmadm.events({name: 'unit-test:events->create'},
                     function handler(evt) {
                         t.ok(evt);
                         t.equal(evt.type, 'create');
                         t.equal(evt.vm.uuid, uuid);
                         streamStop();
                         t.end();
                     },
                     // NOTE: This is called before the handler above
                     function vmadmEventsReady(readyErr, obj) {
                         t.error(readyErr);
                         t.ok(obj);
                         streamStop = obj.stop;
                         // TODO: Is this actually guaranteed to fire before the
                         // handler?
                         vmadm.create(payloads.web00, function onC(err, info) {
                             t.error(err);
                             t.ok(info);
                             t.ok(info.uuid);
                             uuid = info.uuid;
                         });

                     });
    });

    suite.test('multi-events', function (t) {
        const vmadm = testSubject(path.join(os.tmpdir(), SERVER_ROOT));
        t.plan(23);

        let streamStop = null;
        let uuidA = null;
        let uuidB = null;
        let evtIdx = 0;

        const vmadmEventsReady = function vmadmEventsReady(readyErr, obj) {
            t.error(readyErr);
            t.ok(obj);
            streamStop = obj.stop;
            vasync.pipeline({
                funcs: [
                    function stepOne(_, next) {
                        vmadm.create(payloads.web00, function onC(err, info) {
                            t.error(err);
                            t.ok(info);
                            t.ok(info.uuid);
                            uuidA = info.uuid;
                            next();
                         });
                    },
                    function stepTwo(_, next) {
                        vmadm.create(payloads.web01, function onC(err, info) {
                            t.error(err);
                            t.ok(info);
                            t.ok(info.uuid);
                            uuidB = info.uuid;
                            next();
                         });
                    },
                    function stepThree(_, next) {
                        vmadm.stop({'uuid': uuidA}, function onStop(err) {
                            t.error(err);
                            next();
                        });
                    },
                    function stepFour(_, next) {
                        vmadm.delete({'uuid': uuidB}, function onStop(err) {
                            t.error(err);
                            next();
                        });
                    }
                ]
            });
        };


        let seenModify = false;
        let seenDelete = false;
        vmadm.events({name: 'unit-test:multi-events'},
                     // NOTE: modiy and delete don't come in a consistent order
                     function handler(evt) {
                         if (evtIdx === 0) {
                             t.ok(evt);
                             t.equal(evt.type, 'create');
                             t.equal(evt.vm.uuid, uuidA);
                         } else if (evtIdx === 1) {
                             t.ok(evt);
                             t.equal(evt.type, 'create');
                             t.equal(evt.vm.uuid, uuidB);
                         } else {
                             t.ok(evt);
                             if (evt.type === 'modify') {
                                 t.equal(evt.vm.uuid, uuidA);
                                 seenModify = true;
                             } else if (evt.type === 'delete') {
                                 t.equal(evt.zonename, uuidB);
                                 seenDelete = true;
                             } else {
                                 throw new Error('unexpected event', evt);
                             }
                         }

                         if (evtIdx >= 3) {
                             t.equal(evtIdx, 3);
                             t.ok(seenModify);
                             t.ok(seenDelete);
                             streamStop();
                             t.end();
                         }

                         evtIdx += 1;
                     },
                     vmadmEventsReady);
    });

    suite.end();
});
