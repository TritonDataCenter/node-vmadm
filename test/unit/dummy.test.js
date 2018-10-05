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
const uuidv4 = require('uuid/v4');
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
        'autoboot': true,
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
        'autoboot': true,
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
        'autoboot': true,
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
        t.plan(5);
        vmadm.create(payloads.web00, function onCreate(err, info) {
            t.error(err);
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

    //
    // This tests the snapshot functionality by:
    //
    //  * creating a VM
    //  * creating 3 snapshots
    //  * ensuring all 3 snapshots were created
    //  * rolling back to the first snapshot
    //  * ensuring snapshots 2 and 3 were deleted
    //  * delete the remaining snapshot
    //  * ensuring snapshots is now empty
    //
    suite.test('snapshots', function (t) {
        mockfs({[path.join(SERVER_ROOT, SERVER_UUID, 'vms')]: {}});
        const vmadm = testSubject(SERVER_ROOT);
        t.plan(16);

        function _createSnapshot(ctx, name, cb) {
            vmadm.create_snapshot({
                snapshot_name: name,
                uuid: ctx.uuid
            }, function onSnapCreate(err) {
                t.error(err, 'should be no error creating "' + name + '"');
                cb(err);
            });
        }

        vasync.pipeline({
            arg: {},
            funcs: [
                function _createVm(ctx, cb) {
                    vmadm.create(payloads.web00, function onCreate(err, info) {
                        t.error(err, 'create VM for snapshotting');
                        ctx.uuid = info.uuid;
                        cb(err);
                    });
                }, function _createSnapshot1(ctx, cb) {
                    _createSnapshot(ctx, 'snapshot1', cb);
                }, function _createSnapshot2(ctx, cb) {
                    _createSnapshot(ctx, 'snapshot2', cb);
                }, function _createSnapshot3(ctx, cb) {
                    _createSnapshot(ctx, 'snapshot3', cb);
                }, function _checkSnapshots(ctx, cb) {
                    vmadm.load({
                        uuid: ctx.uuid
                    }, function onLoad(err, vmobj) {
                        t.error(err, 'load after snapshotting');
                        t.equal(vmobj.state, 'running', 'VM should be running');
                        t.deepEqual(vmobj.snapshots.map(function _onlyName(s) {
                            return (s.name);
                        }).sort(), [
                            'snapshot1',
                            'snapshot2',
                            'snapshot3'
                        ], 'should see all 3 snapshots');
                        cb(err);
                    });
                }, function _rollbackSnapshot(ctx, cb) {
                    vmadm.rollback_snapshot({
                        snapshot_name: 'snapshot1',
                        uuid: ctx.uuid
                    }, function onRollback(err) {
                        t.error(err, 'rollback to snapshot1');
                        cb(err);
                    });
                }, function _checkSnapshots(ctx, cb) {
                    vmadm.load({
                        uuid: ctx.uuid
                    }, function onLoad(err, vmobj) {
                        t.error(err, 'load after rollback');
                        t.equal(vmobj.state, 'running', 'VM should be running');
                        t.deepEqual(vmobj.snapshots.map(function _onlyName(s) {
                            return (s.name);
                        }).sort(), [
                            'snapshot1'
                        ], 'should see only 1 snapshot');
                        cb(err);
                    });
                }, function _deleteSnapshot(ctx, cb) {
                    vmadm.delete_snapshot({
                        snapshot_name: 'snapshot1',
                        uuid: ctx.uuid
                    }, function onRollback(err) {
                        t.error(err, 'delete snapshot1');
                        cb(err);
                    });
                }, function _checkSnapshots(ctx, cb) {
                    vmadm.load({
                        uuid: ctx.uuid
                    }, function onLoad(err, vmobj) {
                        t.error(err, 'load after delete');
                        t.equal(vmobj.state, 'running', 'VM should be running');
                        t.deepEqual(vmobj.snapshots.map(function _onlyName(s) {
                            return (s.name);
                        }).sort(), [], 'should see 0 snapshots');
                        cb(err);
                    });
                }
            ]
        }, function donePipeline(err) {
            t.error(err, 'snapshot actions should all have succeeded');
            t.end();
        });
    });

    //
    // This tests the vmadm.update functionality by:
    //
    //  * creating a VM
    //  * loading the VM
    //  * modifying some properties with a vmadm.update
    //  * loading the VM again to ensure properties changed as expected
    //
    suite.test('update', function (t) {
        mockfs({[path.join(SERVER_ROOT, SERVER_UUID, 'vms')]: {}});
        var updatePayload = {
            alias: 'robotic_dolphin',
            autoboot: false, // default is true
            image_uuid: uuidv4(),
            billing_id: uuidv4(),
            resolvers: '1.1.1.1,1.0.0.1'
        };
        const vmadm = testSubject(SERVER_ROOT);
        t.plan(5 + (Object.keys(updatePayload).length * 2));

        vasync.pipeline({
            arg: {},
            funcs: [
                function _createVm(ctx, cb) {
                    vmadm.create(payloads.web00, function onCreate(err, info) {
                        t.error(err, 'create VM for updating');
                        ctx.uuid = info.uuid;
                        cb(err);
                    });
                }, function _loadInitialVm(ctx, cb) {
                    vmadm.load({
                        uuid: ctx.uuid
                    }, function onLoad(err, vmobj) {
                        t.error(err, 'load after creation');
                        ctx.originalVmobj = vmobj;
                        cb(err);
                    });
                }, function _doUpdates(ctx, cb) {
                    updatePayload.uuid = ctx.uuid;
                    vmadm.update(updatePayload, function onUpdate(err) {
                        t.error(err, 'perform update');
                        cb(err);
                    });
                }, function _loadFinalVm(ctx, cb) {
                    vmadm.load({
                        uuid: ctx.uuid
                    }, function onLoad(err, vmobj) {
                        var idx;
                        var field;
                        var fields = Object.keys(updatePayload);
                        var origVm = ctx.originalVmobj;

                        t.error(err, 'load after update');
                        for (idx = 0; idx < fields.length; idx++) {
                            field = fields[idx];
                            if (field === 'uuid') {
                                // This won't change.
                                continue;
                            }

                            t.notEqual(origVm[field], vmobj[field],
                                'expected ' + field + ' to change');
                            t.equal(vmobj[field], updatePayload[field],
                                'expected ' + field + ' to match update');
                        }
                        cb(err);
                    });
                }
            ]
        }, function donePipeline(err) {
            t.error(err, 'update actions should all have succeeded');
            t.end();
        });
    });

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

    //
    // This test starts a vmadm.events watcher, and when that emits the "ready"
    // event, creates a VM (A). From that point, each event seen by the handler
    // triggers another action which triggers another event until the final
    // action is triggered and things are torn down.
    //
    //    "create" event for VM A triggers: creation of VM B
    //    "create" event for VM B triggers: stop of VM A
    //    "modify" event for VM A (due to stop) triggers: deletion of VM B
    //    "delete" event for VM B is the final event and triggers cleanup
    //
    suite.test('multi-events', function (t) {
        const vmadm = testSubject(path.join(os.tmpdir(), SERVER_ROOT));
        t.plan(19);

        let streamStop = null;
        let uuidA = null;
        let uuidB = null;

        const vmadmEventsReady = function vmadmEventsReady(readyErr, obj) {
            t.error(readyErr, 'ready handler should have no error');
            t.ok(obj, 'ready handler was passed object');
            streamStop = obj.stop;

            // Do the first create, this kicks things off. When this event is
            // seen by vmadm.events, it will kick off the next step by calling
            // the handler.
            vmadm.create(payloads.web00, function onC(err, info) {
                t.error(err, 'vmadm.create <A> should succeed');
                t.ok(info, 'vmadm.create <A> should return VM info');
                t.ok(info.uuid, 'vmadm.create <A> VM info should have uuid');
                uuidA = info.uuid;
            });
        };

        vmadm.events({
            name: 'unit-test:multi-events'
        }, function handler(evt) {
            if (evt.type === 'create' && evt.vm.uuid === uuidA) {
                // The first "create" (A) triggers the second create (B)
                t.ok(evt, 'saw evt for creation of VM A');
                vmadm.create(payloads.web01, function onC(err, info) {
                    t.error(err, 'vmadm.create <B> should succeed');
                    t.ok(info, 'vmadm.create <B> should return VM info');
                    t.ok(info.uuid,
                        'vmadm.create <B> VM info should have uuid');
                    uuidB = info.uuid;
                });
            } else if (evt.type === 'create' && evt.vm.uuid === uuidB) {
                // The second "create" (B) triggers the stop of A
                t.ok(evt, 'saw evt for creation of VM B');
                vmadm.stop({'uuid': uuidA}, function onStop(err) {
                    t.error(err, 'vmadm.stop <A> should succeed');
                });
            } else if (evt.type === 'modify') {
                // The "modify" (due to stop) triggers the delete of B
                t.ok(evt, 'saw evt for stop of A');
                t.ok(evt.vm, 'evt for modify should have a vm object');
                t.equal(evt.vm.uuid, uuidA,
                    'VM in modify should have A\'s UUID');
                t.equal(evt.vm.state, 'stopped',
                    'VM in modify should have state "stopped"');
                t.equal(evt.zonename, uuidA, 'evt.zonename should be A\'s');
                vmadm.delete({'uuid': uuidB}, function onStop(err) {
                    t.error(err, 'vmadm.delete <B> should succeed');
                });
            } else if (evt.type === 'delete') {
                // When we see the "delete" for B, we're done
                t.ok(evt, 'saw evt for delete of <B>');
                t.equal(evt.zonename, uuidB, 'evt.zonename should be B\'s');
                streamStop();
                t.end();
            } else {
                throw new Error('unexpected event', evt);
            }
        }, vmadmEventsReady);
    });

    suite.end();
});
