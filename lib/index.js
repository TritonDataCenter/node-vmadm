/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var execFile = require('child_process').execFile;


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
 * @param options {Object}
 *      - uuid {String} The VM uuid.
 *      - log {Logger object}
 * @param options {Object} Optional vm options
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

    var args = ['lookup', '-j'];

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

        if (!vms || !vms.length) {
            return new Error('no vms returned');
        }

        vms = vms[0];

        return callback(null, vms);
    });
};





module.exports = vmadm;
