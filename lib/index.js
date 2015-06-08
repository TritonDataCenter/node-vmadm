/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var cp = require('child_process');
var execFile = cp.execFile;
var spawn = cp.spawn;


var VMADM_PATH = '/usr/sbin/vmadm';

function vmadm() {}

function execVmadm(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.arrayOfString(opts.args, 'opts.args');
    var args = opts.args;

    opts.log.info({ args: args }, 'executing vmadm');

    return execFile(VMADM_PATH, args, function (err, stdout, stderr) {
        return callback(err, stdout, stderr);
    });
}



/**
 * Call `vmadm lookup -j UUID`.
 *
 * @param opts {Object} Options
 *      - uuid {String} The VM uuid.
 *      - log {Logger object}
 * @param vmopts {Object} Optional vm options
 *      - fields {Array} Return only the keys give in `fields` array
 * @param callback {Function} `function (err)`
 */

vmadm.load = function vmLoad(opts, vmopts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');

    if (!callback) {
        callback = vmopts;
    }

    function addargs(newargs) {
        Array.prototype.push.apply(args, newargs);
    }

    var args = ['lookup', '-1', '-j'];

    if (vmopts && vmopts.fields) {
        addargs(['-o', opts.fields.join(',')]);
    }

    args.push('uuid=' + opts.uuid);

    var execopts = {
        args: args,
        log: opts.log
    };

    execVmadm(execopts, function (err, stdout, stderr) {
        if (err) {
            return callback(err);
        }
        var vms;

        try {
            vms = JSON.parse(stdout);
        } catch (jsonErr) {
            jsonErr.stdout = stdout;
            return callback(jsonErr);
        }

        var vm;
        if (vms.length) {
            vm = vms[0];
        }

        return callback(null, vm);
    });
};



/**
 * Call `vmadm create`.
 *
 * @param opts {Object} Options
 *      - log {Logger object}
 * @param callback {Function} `function (err)`
 */

vmadm.create = function vmCreate(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    var log = opts.log;
    delete opts.log;
    log.info('spawning vmadm for machine create');

    var vmadmproc = spawn(VMADM_PATH, ['create']);
    var stderr = '';

    vmadmproc.stdin.write(JSON.stringify(opts));
    vmadmproc.stdin.end();

    vmadmproc.on('close', function (code) {
        if (code) {
            callback(new Error(stderr.trim()));
            return;
        }
        callback();
    });

    vmadmproc.stderr.on('data', function (data) {
        stderr += data.toString();
    });
};



/**
 * Call `vmadm delete <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to delete
 *      - log {Logger object}
 * @param callback {Function} `function (err)`
 */

vmadm.delete = function vmDelete(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.object(opts.log, 'opts.log');

    var args = ['delete', opts.uuid];

    var execopts = {
        args: args,
        log: opts.log
    };

    execVmadm(execopts, function (err, stdout, stderr) {
        if (err) {
            return callback(err);
        }
        return callback();
    });
};



/**
 * Call `vmadm update`.
 *
 * @param opts {Object} VMADM update payload
 *      - log {Logger object}
 * @param callback {Function} `function (err)`
 */

vmadm.update = function vmUpdate(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.object(opts.log, 'opts.log');

    var log = opts.log;
    delete opts.log;
    log.info('spawning vmadm for machine update');

    var vmadmproc = spawn(VMADM_PATH, ['update', opts.uuid]);
    var stderr = '';

    vmadmproc.stdin.write(JSON.stringify(opts));
    vmadmproc.stdin.end();

    vmadmproc.on('close', function (code) {
        if (code) {
            callback(new Error(stderr.trim()));
            return;
        }
        callback();
    });

    vmadmproc.stderr.on('data', function (data) {
        stderr += data.toString();
    });
};



/**
 * Call `vmadm reboot <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to reboot
 *      - force {Boolean} Whether to force the reboot.
 *      - log {Logger object}
 * @param callback {Function} `function (err)`
 */

vmadm.reboot = function vmReboot(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.object(opts.log, 'opts.log');

    var args = ['reboot', opts.uuid];

    if (opts.force) {
        args.push('-F');
    }

    var execopts = {
        args: args,
        log: opts.log
    };

    execVmadm(execopts, function (err, stdout, stderr) {
        if (err) {
            return callback(err);
        }
        return callback();
    });
};



/**
 * Call `vmadm reprovision`.
 *
 * @param opts {Object} VMADM reprovision payload
 *      - log {Logger object}
 *      - uuid {String} uuid of vm to be reprovisioned
 * @param callback {Function} `function (err)`
 */

vmadm.reprovision = function vmUpdate(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.object(opts.log, 'opts.log');

    var log = opts.log;
    delete opts.log;
    log.info('spawning vmadm for machine update');

    var vmadmproc = spawn(VMADM_PATH, ['reprovision', opts.uuid]);
    var stderr = '';

    vmadmproc.stdin.write(JSON.stringify(opts));
    vmadmproc.stdin.end();

    vmadmproc.on('close', function (code) {
        if (code) {
            callback(new Error(stderr.trim()));
            return;
        }
        callback();
    });

    vmadmproc.stderr.on('data', function (data) {
        stderr += data.toString();
    });
};



module.exports = vmadm;
