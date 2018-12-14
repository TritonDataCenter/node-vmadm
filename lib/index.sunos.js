/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var cp = require('child_process');
var fs = require('fs');
var LineStream = require('lstream');
var path = require('path');
var spawn = cp.spawn;
var stream = require('stream');
var util = require('util');

var VMADM_PATH = '/usr/sbin/vmadm';

var STDERR_TRUNCATE_LENGTH = 10000;

function vmadm() {}

function copyEnv() {
    var ret = {};
    Object.keys(process.env).forEach(function processEnvForEach(key) {
        ret[key] = process.env[key];
    });
    return ret;
}

/*
 * Execute vmadm
 *
 * @param opts {Object} Options
 *      - args {Array} cmdline args for vmadm
 *      - log {Logger object}
 *      - req_id {String} request id for this request (to tie to callers)
 * @param callback {Function} `function (result, stdout, stderrLines)`
 *      - called on vmadm exit
 *      - result is an Object that contains code: ..., signal: ...
 *      - stdout is a string of all data written to stdout
 *      - stderrLines is an array of all the lines written to stderr
 *
 */
function execVmadm(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.arrayOfString(opts.args, 'opts.args');
    assert.optionalString(opts.req_id, 'opts.req_id');

    var args = opts.args;
    var child;
    var execOpts = {};
    var stderrBuffer = '';
    var stderrLines = [];
    var stdoutBuffer = '';

    execOpts.env = copyEnv();
    if (opts.req_id) {
        opts.log.info('setting req_id to "%s"', opts.req_id);
        execOpts.env.REQ_ID = opts.req_id;
    }
    execOpts.env.VMADM_DEBUG_LEVEL = 'debug';

    opts.log.trace({ args: args, execOpts: execOpts }, 'executing vmadm');

    child = spawn(VMADM_PATH, args, execOpts);

    child.stdout.on('data', function _childStdoutHandler(data) {
        stdoutBuffer += data.toString();
    });

    child.stderr.on('data', function _childStderrHandler(data) {
        var chunk;
        var chunks;

        stderrBuffer += data.toString();
        chunks = stderrBuffer.split('\n');
        while (chunks.length > 1) {
            chunk = chunks.shift();
            stderrLines.push(chunk);
        }
        stderrBuffer = chunks.pop();
    });

    child.on('close', function _childCloseHandler(code, signal) {
        var errCode;
        var lastLine;
        var logErrorLevel = 'error';

        if (stderrBuffer.length > 0) {
            opts.log.info('stderr from vmadm: ' + stderrBuffer);
            stderrLines.push(stderrBuffer);
        }

        if (code !== 0 || signal !== null) {
            if (stderrLines.length > 0) {
                lastLine = stderrLines[stderrLines.length - 1];
                if (lastLine
                    .match(/^Requested unique lookup but found 0 results./)) {
                    // It's not really an error when you do a lookup and get 0
                    // results, so we'll not write it to the log as an error. We
                    // do log so that it's available when tracing.
                    logErrorLevel = 'trace';
                } else if (lastLine.match(/No such zone configured/)) {
                    // If a VM doesn't exist, that's also not really an error.
                    logErrorLevel = 'trace';
                } else if (lastLine
                    .match(/Cannot find running init PID for VM/)) {
                    // If a VM is not running: return ENOTRUNNING
                    errCode = 'ENOTRUNNING';
                }
            }
            opts.log[logErrorLevel]({
                code: code,
                errCode: errCode,
                signal: signal,
                cmdline: [VMADM_PATH].concat(args),
                stdout: stdoutBuffer,
                stderrLines: stderrLines
            }, 'error executing vmadm');
        } else {
            opts.log.trace('vmadm child closed with (%d, ' + signal + ')',
                code);
        }

        callback({code: code, errCode: errCode, signal: signal},
            stdoutBuffer, stderrLines);
    });

    if (opts.stdinData) {
        child.stdin.write(opts.stdinData);
    }
    child.stdin.end();
}


/**
 * Check whether VM exists or not and calls the appropriate callback.
 *
 * @param opts {Object} Options
 *      - uuid {String} The VM uuid.
 *      - log {Logger object}
 *      - include_dni {Boolean} If true, return VMs that have do_not_inventory
 *        set. default: false.
 * @param exist_cb {Function} `function (err)`
 *      - called when VM opts.uuid exists
 * @param nonexist_cb {Function} `function (err)`
 *      - called when VM opts.uuid does not exist
 */
function ifExists(opts, exist_cb, nonexist_cb) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    /*
     * Until vminfod (OS-2647) is available, we want a way to quickly filter out
     * VMs that should not be included. Looking at the xml file for the
     * do-not-inventory property is a quick-and-dirty way to do that.
     */

    var dni = new
        RegExp('<attr name="do-not-inventory" type="string" value="true"/>');
    var filename = path.join('/etc/zones', opts.uuid + '.xml');
    var log = opts.log;

    fs.readFile(filename, function (err, data) {
        var noExistErr;

        if (err && err.code === 'ENOENT') {
            /*
             * VM doesn't exist at all.
             */
            log.trace('ifExists(): ' + filename + ' does not exist');
            noExistErr = new Error('VM does not exist');
            noExistErr.restCode = 'VmNotFound';
            nonexist_cb(noExistErr);
        } else if (err) {
            /*
             * Condition we didn't anticipate, not sure what it means. Hopefully
             * caller will know what to do.
             */
            log.trace(err, 'ifExists(): error loading ' + filename);
            nonexist_cb(err);
        } else if (data.toString().match(dni) && !opts.include_dni) {
            /*
             * VM is marked do_not_inventory. And we don't have include_dni
             * option set indicating we want to include those, so we treat the
             * same as not existing.
             */
            log.trace(err, 'ifExists(): ' + filename + ' has do_not_inventory');
            noExistErr = new Error('VM does not exist');
            noExistErr.restCode = 'VmNotFound';
            nonexist_cb(noExistErr);
        } else {
            /*
             * VM exists and do-not-inventory is not set (or we're including).
             */
            log.trace(err, 'ifExists(): ' + filename + ' exists');
            exist_cb();
        }
    });
}



/**
 * Check whether a VM exists or not.
 *
 * @param opts {Object} Options
 *      - uuid {String} The VM uuid.
 *      - log {Logger object}
 *      - include_dni {Boolean} If true, return VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err, exists)`
 *      - err is set on unhandled error
 *      - otherwise; exists will be true or false
 */

vmadm.exists = function vmExists(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    ifExists(opts, function () {
        // exists
        callback(null, true);
    }, function (err) {
        if (err && err.restCode === 'VmNotFound') {
            callback(null, false);
        } else if (err) {
            callback(err);
        } else {
            callback(null, false);
        }
    });
};



/**
 * Call `vmadm get UUID`.
 *
 * @param opts {Object} Options
 *      - uuid {String} The VM uuid.
 *      - log {Logger object}
 * @param vmopts {Object} Optional vm options
 *      - fields {Array} Return only the keys give in `fields` array
 *      - include_dni {Boolean} If true, return VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.load = function vmLoad(opts, vmopts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    if (!callback) {
        callback = vmopts;
    }

    var execOpts = {
        args: ['get', opts.uuid],
        log: opts.log,
        req_id: opts.req_id
    };

    opts.log.trace('spawning vmadm for load');

    execVmadm(execOpts, function (result, stdout, stderrLines) {
        var err;
        var vm;

        function notFound() {
            var notFoundErr;

            // NOTE: destroy depends on this matching ': No such zone'
            notFoundErr = new Error('vmadm load ' + opts.uuid +
                ' failed: No such zone');
            notFoundErr.restCode = 'VmNotFound';

            return notFoundErr;
        }

        if (result.code !== 0 || result.signal !== null) {
            if (stderrLines[stderrLines.length - 1]
                .match(/No such zone configured/)) {
                // VM does not exist.
                return callback(notFound());
            }
            err = new Error('vmadm exited with code: ' + result.code +
                ' signal: ' + result.signal + ' -- ' +
                stderrLines.join('\n'));
            err.stderr = stderrLines.join('\n');
            return callback(err);
        }

        try {
            vm = JSON.parse(stdout);
        } catch (jsonErr) {
            jsonErr.stdout = stdout;
            return callback(jsonErr);
        }

        if (vm.do_not_inventory && !opts.include_dni) {
            // Unless the caller is specifically asking for VMs that are
            // do_not_inventory, we treat them the same a VMs that don't exist.
            return callback(notFound());
        }

        if (opts.fields) {
            Object.keys(vm).forEach(function _removeUnwantedFields(field) {
                if (opts.fields.indexOf(field) === -1) {
                    // not a field we want
                    delete vm[field];
                }
            });
        }

        return callback(null, vm);
    });
};



/**
 * Call `vmadm create`.
 *
 * @param opts {Object} Options
 *      - log {Logger object}
 * @param callback {Function} `function (err, info)`
 */

vmadm.create = function vmCreate(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');

    var execOpts = {};
    var log = opts.log;
    var payload = opts;
    delete payload.log;

    log.trace('spawning vmadm for create');

    execOpts.log = log;
    execOpts.args = ['create'];
    execOpts.req_id = opts.req_id;
    delete payload.req_id;
    // Support removed w/ TRITON-985, still deleted for backward compat.
    delete payload.vmadmLogger;

    execOpts.stdinData = JSON.stringify(payload);

    execVmadm(execOpts, function (result, stdout, stderrLines) {
        var info = {};

        if (result.code !== 0 || result.signal !== null) {
            var lastLine = '';
            var lines = '';
            if (stderrLines.length > 1) {
                lastLine = stderrLines[stderrLines.length - 1];
                lines = stderrLines.join('\n').trim().substr(
                        -STDERR_TRUNCATE_LENGTH);
            }

            return callback(
                new Error('vmadm exited with code: ' + result.code + ': ' +
                          lastLine + '\n...' + lines));
        }

        stderrLines.forEach(function (line) {
            /* JSSTYLED */
            var matches = line.match(/^Successfully created VM (.*)$/);
            if (matches) {
                info.uuid = matches[1];
            }
        });

        return callback(null, info);
    });
};



/**
 * Call `vmadm delete <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to delete
 *      - log {Logger object}
 *      - include_dni {Boolean} If true, delete VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.delete = function vmDelete(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var args = ['delete', opts.uuid];

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    ifExists(opts, function _ifExistsCb() {
        opts.log.trace('spawning vmadm for delete');

        execVmadm(execOpts, function (result, stdout, stderrLines) {
            var err;

            if (result.code !== 0 || result.signal !== null) {
                err = new Error('vmadm exited with code: ' + result.code +
                    ' signal: ' + result.signal);
                err.stderrLines = stderrLines.join('\n');
                return callback(err);
            }
            return callback();
        });
    }, callback);
};



/**
 * Call `vmadm update`.
 *
 * @param opts {Object} VMADM update payload
 *      - log {Logger object}
 *      - include_dni {Boolean} If true, update VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.update = function vmUpdate(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var execOpts = {};
    var existsOpts = {};
    var log = opts.log;
    var payload = opts;
    delete payload.log;

    log.trace('spawning vmadm for machine update');

    execOpts.log = log;
    execOpts.args = ['update', opts.uuid];
    execOpts.req_id = opts.req_id;
    delete payload.req_id;
    // Support removed w/ TRITON-985, still deleted for backward compat.
    delete payload.vmadmLogger;

    existsOpts.log = log;
    existsOpts.uuid = opts.uuid;
    existsOpts.include_dni = opts.include_dni;
    delete payload.include_dni;

    execOpts.stdinData = JSON.stringify(payload);

    ifExists(existsOpts, function _ifExistsCb() {
        execVmadm(execOpts, function (result, stdout, stderrLines) {
            if (result.code !== 0 || result.signal !== null) {
                callback(new Error(stderrLines.join('\n').trim()));
                return;
            }
            callback();
        });
    }, callback);
};



/**
 * Call `vmadm reboot <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to reboot
 *      - force {Boolean} Whether to force the reboot.
 *      - log {Logger object}
 *      - include_dni {Boolean} If true, reboot VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.reboot = function vmReboot(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var args = ['reboot', opts.uuid];

    if (opts.force) {
        args.push('-F');
    }

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    ifExists(opts, function _ifExistsCb() {
        execVmadm(execOpts, function (result, stdout, stderrLines) {
            var err;

            if (result.code !== 0 || result.signal !== null) {
                err = new Error('vmadm exited with code: ' + result.code +
                    ' signal: ' + result.signal);
                err.stderr = stderrLines.join('\n');
                return callback(err);
            }
            return callback();
        });
    }, callback);
};



/**
 * Call `vmadm reprovision`.
 *
 * @param opts {Object} VMADM reprovision payload
 *      - log {Logger object}
 *      - uuid {String} uuid of vm to be reprovisioned
 *      - include_dni {Boolean} If true, reprovision VMs that have
 *        do_not_inventory set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.reprovision = function vmReprovision(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var execOpts = {};
    var existsOpts = {};
    var log = opts.log;
    var payload = opts;
    delete payload.log;

    execOpts.log = log;
    execOpts.args = ['reprovision', opts.uuid];
    execOpts.req_id = opts.req_id;
    delete payload.req_id;
    // Support removed w/ TRITON-985, still deleted for backward compat.
    delete payload.vmadmLogger;

    existsOpts.log = log;
    existsOpts.uuid = opts.uuid;
    existsOpts.include_dni = opts.include_dni;
    delete payload.include_dni;

    execOpts.stdinData = JSON.stringify(payload);

    ifExists(existsOpts, function _ifExistsCb() {
        execVmadm(execOpts, function (result, stdout, stderrLines) {
            if (result.code !== 0 || result.signal !== null) {
                callback(new Error(stderrLines.join('\n').trim()));
                return;
            }
            callback();
        });
    }, callback);
};



/**
 * Call `vmadm lookup -j`.
 *
 * @param opts {Object} Options
 *      - uuid {String} The VM uuid.
 *      - log {Logger object}
 * @param vmopts {Object} Optional vm options
 *      - fields {Array} Return only the keys give in `fields` array
 *      - include_dni {Boolean} If true, return VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err, vms)`
 */

vmadm.lookup = function vmLookup(search, opts, callback) {
    assert.object(search, 'search');
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var args = ['lookup', '-j'];

    function addargs(newargs) {
        Array.prototype.push.apply(args, newargs);
    }

    if (opts && opts.fields) {
        /*
         * Since we want to ignore VMs that have do_not_inventory=true, we add
         * that  if it's not there. Since the field is not returned when it's
         * not set, there's no need to undo this later. (AGENT-953)
         */
        if (opts.fields.indexOf('do_not_inventory') === -1) {
            opts.fields.push('do_not_inventory');
        }
        addargs(['-o', opts.fields.join(',')]);
    }

    Object.keys(search).forEach(function (name) {
        args.push(name + '=' + search[name]);
    });

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    execVmadm(execOpts, function (result, stdout, stderrLines) {
        var err;
        var vms = [];

        if (result.code !== 0 || result.signal !== null) {
            err = new Error('vmadm exited with code: ' + result.code +
                ' signal: ' + result.signal + ' -- ' +
                stderrLines.join('\n'));
            err.stderr = stderrLines.join('\n');
            return callback(err);
        }

        try {
            JSON.parse(stdout).forEach(function (vm) {
                if (vm.do_not_inventory && !opts.include_dni) {
                    return;
                }
                vms.push(vm);
            });
        } catch (jsonErr) {
            jsonErr.stdout = stdout;
            return callback(jsonErr);
        }

        return callback(null, vms);
    });
};



/**
 * Call `vmadm kill <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to kill
 *      - log {Logger object}
 *      - signal {String} Optional signal to send, eg 'SIGTERM'
 *      - include_dni {Boolean} If true, kill VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.kill = function vmKill(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalString(opts.signal, 'opts.signal');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var args = ['kill'];

    function addargs(newargs) {
        Array.prototype.push.apply(args, newargs);
    }

    if (opts.signal) {
        addargs(['-s', opts.signal]);
    }

    args.push(opts.uuid);

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    ifExists(opts, function _ifExistsCb() {
        execVmadm(execOpts, function (result, stdout, stderrLines) {
            var err;

            if (result.code !== 0 || result.signal !== null) {
                err = new Error('vmadm exited with code: ' + result.code +
                    ' signal: ' + result.signal);
                if (result.errCode) {
                    err.code = result.errCode;
                }
                err.stderr = stderrLines.join('\n');
                return callback(err);
            }
            return callback();
        });
    }, callback);
};



/**
 * Call `vmadm info <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of KVM to run info on
 *      - log {Logger object}
 *      - types {Array of Strings} Optional array of type strings
 *      - include_dni {Boolean} If true, gather info from VMs that have
 *        do_not_inventory set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.info = function vmInfo(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalArrayOfString(opts.types, 'opts.types');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var args = ['info', opts.uuid];

    if (opts.types && opts.types.length > 0) {
        args.push(opts.types.join(','));
    }

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    ifExists(opts, function _ifExistsCb() {
        execVmadm(execOpts, function (result, stdout, stderrLines) {
            var err;

            if (result.code !== 0 || result.signal !== null) {
                err = new Error('vmadm exited with code: ' + result.code +
                    ' signal: ' + result.signal);
                err.stderr = stderrLines.join('\n');
                return callback(err);
            }
            return callback(null, stdout);
        });
    }, callback);
};



/**
 * Call `vmadm sysrq <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of KVM to run sysrq on
 *      - log {Logger object}
 *      - req {String} Type of request, 'screenshot' or 'nmi'
 *      - include_dni {Boolean} If true, send sysrq to VMs that have
 *        do_not_inventory set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.sysrq = function vmSysrq(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.req, 'opts.req');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var args = ['sysreq', opts.uuid, opts.req];

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    ifExists(opts, function _ifExistsCb() {
        execVmadm(execOpts, function (result, stdout, stderrLines) {
            var err;

            if (result.code !== 0 || result.signal !== null) {
                err = new Error('vmadm exited with code: ' + result.code +
                    ' signal: ' + result.signal);
                err.stderr = stderrLines.join('\n');
                return callback(err);
            }
            return callback();
        });
    }, callback);
};



/**
 * Call `vmadm create-snapshot <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID VM to snapshot
 *      - log {Logger object}
 *      - snapshot_name {String} name to give the snapshot
 *      - include_dni {Boolean} If true, snapshot VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.create_snapshot = function vmCreateSnapshot(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.snapshot_name, 'opts.snapshot_name');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var args = ['create-snapshot', opts.uuid, opts.snapshot_name];

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    ifExists(opts, function _ifExistsCb() {
        execVmadm(execOpts, function (result, stdout, stderrLines) {
            var err;

            if (result.code !== 0 || result.signal !== null) {
                err = new Error('vmadm exited with code: ' + result.code +
                    ' signal: ' + result.signal);
                err.stderr = stderrLines.join('\n');
                return callback(err);
            }
            return callback();
        });
    }, callback);
};



/**
 * Call `vmadm rollback-snapshot <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM container snapshot to rollback
 *      - log {Logger object}
 *      - snapshot_name {String} name of snapshot to rollback
 *      - include_dni {Boolean} If true, rollback snapshots for VMs that have
 *        do_not_inventory set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.rollback_snapshot = function vmRollbackSnapshot(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.snapshot_name, 'opts.snapshot_name');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var args = ['rollback-snapshot', opts.uuid, opts.snapshot_name];

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    ifExists(opts, function _ifExistsCb() {
        execVmadm(execOpts, function (result, stdout, stderrLines) {
            var err;

            if (result.code !== 0 || result.signal !== null) {
                err = new Error('vmadm exited with code: ' + result.code +
                    ' signal: ' + result.signal);
                err.stderr = stderrLines.join('\n');
                return callback(err);
            }
            return callback();
        });
    }, callback);
};



/**
 * Call `vmadm delete-snapshot <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM container snapshot to delete
 *      - log {Logger object}
 *      - snapshot_name {String} name of the snapshot to delete
 *      - include_dni {Boolean} If true, delete snapshots for VMs that have
 *        do_not_inventory set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.delete_snapshot = function vmDeleteSnapshot(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.snapshot_name, 'opts.snapshot_name');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var args = ['delete-snapshot', opts.uuid, opts.snapshot_name];

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    ifExists(opts, function _ifExistsCb() {
        execVmadm(execOpts, function (result, stdout, stderrLines) {
            var err;

            if (result.code !== 0 || result.signal !== null) {
                err = new Error('vmadm exited with code: ' + result.code +
                    ' signal: ' + result.signal);
                err.stderr = stderrLines.join('\n');
                return callback(err);
            }
            return callback();
        });
    }, callback);
};



/**
 * Call `vmadm start <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to start
 *      - log {Logger object}
 *      - include_dni {Boolean} If true, start VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.start = function vmStart(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var args = ['start', opts.uuid];

    var vals = ['cdrom', 'disk', 'order', 'once'];
    vals.forEach(function (name) {
        if (!opts[name]) {
            return;
        }

        if (Array.isArray(opts[name])) {
            opts[name].forEach(function (item) {
                args.push(name + '=' + item);
            });
        } else {
            args.push(name + '=' + opts[name]);
        }
    });

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    ifExists(opts, function _ifExistsCb() {
        opts.log.trace('spawning vmadm for start');

        execVmadm(execOpts, function (result, stdout, stderrLines) {
            var err;

            if (result.code !== 0 || result.signal !== null) {
                err = new Error('vmadm exited with code: ' + result.code +
                    ' signal: ' + result.signal);
                err.stderrLines = stderrLines.join('\n');
                return callback(err);
            }
            return callback();
        });
    }, callback);
};



/**
 * Call `vmadm stop <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to stop
 *      - force {Boolean} Whether to force the stop
 *      - log {Logger object}
 *      - include_dni {Boolean} If true, stop VMs that have do_not_inventory
 *        set. default: false.
 *      - timeout {Number} If set, timeout in seconds between sending SIGTERM
 *        and SIGKILL when stopping docker containers.
 * @param callback {Function} `function (err)`
 */

vmadm.stop = function vmStop(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.optionalNumber(opts.timeout, 'opts.timeout');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var args = ['stop', opts.uuid];

    if (opts.force) {
        args.push('-F');
    }

    if (opts.timeout) {
        // all args are required to be strings
        args.push('-t', opts.timeout.toString());
    }

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    ifExists(opts, function _ifExistsCb() {
        opts.log.trace('spawning vmadm for stop');

        execVmadm(execOpts, function (result, stdout, stderrLines) {
            var err;

            if (result.code !== 0 || result.signal !== null) {
                err = new Error('vmadm exited with code: ' + result.code +
                    ' signal: ' + result.signal);
                err.stderrLines = stderrLines.join('\n');
                return callback(err);
            }
            return callback();
        });
    }, callback);
};

/*
 * Wrapper around `vmadm events -jr [uuid]`
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to watch, if unset all VMs are watched
 *      - log {Logger object}
 *      - name {String} Identifier string for debugging purposes, this will be
 *      used to construct the user-agent sent to vminfod
 * @param handler {Function} `function (ev)`
 *      - called when an event is seen
 * @param callback {Function} `function (err, obj)`
 *      - called when the stream is ready, or failed to start
 *      - err {Error} set if an error occured that means the stream cannot be
 *      created
 *      - stop {Function} function to stop the event stream
 * @return vs {VmadmCLIEventStream}
 *      - Can be used to listen for errors, ex: `vs.on('error', ...)`
 */
vmadm.events = function vmEvents(opts, handler, callback) {
    var vs;
    var log;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.uuid, 'opts.uuid');
    assert.optionalString(opts.name, 'opts.name');

    log = opts.log;
    vs = new VmadmCLIEventStream(opts);

    vs.once('ready', function vmadmStreamReady(err, ready_ev) {
        log.debug({err: err}, 'vmadm event stream ready event');
        var obj = {
            ev: ready_ev,
            stop: vmadmEventsStop
        };
        callback(err, obj);
    });

    vs.on('readable', function vmadmStreamReadable() {
        var ev;
        while ((ev = vs.read()) !== null) {
            processVmadmEvent(ev);
        }
    });

    function processVmadmEvent(ev) {
        log.trace({ev: ev}, 'vmadm event');
        handler(ev);
    }

    function vmadmEventsStop() {
        log.debug('vmadm events stop called');
        vs.stop();
    }

    return vs;
};

function VmadmCLIEventStream(opts) {
    var self = this;

    var args = ['events', '-rj'];
    var spawnOpts = {};

    stream.Transform.call(self, {objectMode: true});

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.optionalString(opts.name, 'opts.name');
    assert.optionalString(opts.uuid, 'opts.uuid');

    if (opts.uuid) {
        args.push(opts.uuid);
    }

    self.stopped = false;
    self.log = opts.log;

    self.log.info({args: args}, 'calling %s %s',
        VMADM_PATH, args.join(' '));

    spawnOpts.env = copyEnv();
    if (opts.req_id) {
        self.log.info('setting req_id to "%s"', opts.req_id);
        spawnOpts.env.REQ_ID = opts.req_id;
    }
    if (opts.name) {
        self.log.info('setting name to "%s"', opts.name);
        spawnOpts.env.VMADM_IDENT = opts.name;
    }
    spawnOpts.env.VMADM_DEBUG_LEVEL = 'fatal';

    // fork vmadm
    self.child = cp.spawn(VMADM_PATH, args, spawnOpts);
    self.child.stdout.setEncoding('utf8');
    self.child.stderr.setEncoding('utf8');

    // Any child error will be logged and re-emitted
    self.child.on('error', function vmadmProcessError(e) {
        self.log.error({err: e}, 'child process error');
        self.emit('error', e);
    });

    // The child dying is either an info or error message depending
    // on if it was intentional (ie. .stop() was called)
    self.child.on('close', function vmadmProcessClose(code, signal) {
        if (self.stopped) {
            self.log.info({code: code, signal: signal},
                'vmadm events stopped');
            return;
        }

        var e = new Error('child exited');
        self.log.error({err: e, code: code, signal: signal},
            'vmadm events child process closed');
        self.emit('error', e);
    });

    // stdin is not needed
    self.child.stdin.end();

    // Parse stdout line by line by piping to ourselves
    self.child.stdout.pipe(new LineStream()).pipe(self);

    /*
     * Parse stderr line by line - any stderr produced is a fatal error
     * unexpected by the child process, so we log the error and abort the child
     * process to generate a core dump.
     *
     * The only exception to this rule is if "events" has not been implemented
     * yet by `vmadm`.
     */
    var stderrls = new LineStream();
    self.child.stderr.pipe(stderrls).on('readable',
        function vmadmStderrReadable() {

        var lines = [];
        var line;
        while ((line = stderrls.read()) !== null) {
            lines.push(line);
        }

        // If we have already been stopped don't abort the process
        if (self.stopped) {
            return;
        }

        self.log.error({stderr: lines.join('\n')}, 'stderr produced');

        /*
         * Check if the `vmadm events` command is unimplemented.  If so, emit
         * an error object through the "ready" event.
         */
        var invalidCmd = lines.some(function stderrFindInvalidCmd(_line) {
            return (_line === 'Invalid command: "events".');
        });
        if (invalidCmd) {
            self.emit('ready', new Error('`vmadm events` not implemented'));
            self.stop();
            return;
        }

        // If we are here, we didn't expect this stderr so abort the process.
        self._abort();
    });
}
util.inherits(VmadmCLIEventStream, stream.Transform);

/*
 * The transform method to process vmadm stdout line-by-line
 */
VmadmCLIEventStream.prototype._transform =
    function _transform(chunk, _encoding, cb) {

    var self = this;

    var line = chunk.toString('utf8');
    var ev;
    try {
        ev = JSON.parse(line);
        assert.object(ev, 'ev');
        assert.string(ev.type, 'ev.type');
        assert.string(ev.date, 'ev.date');

        ev.date = new Date(ev.date);
        assert.ok(isFinite(ev.date), 'invalid ev.date');
    } catch (e) {
        /*
         * Any JSON parse failure is a fatal error where we abort the child
         * process to generate a core dump
         */
        self.log.error({err: e, line: line},
            'failed to parse output line');
        self._abort();
        return;
    }

    switch (ev.type) {
    case 'ready':
        self.emit('ready', null, ev);
        break;
    default:
        self.push(ev);
        break;
    }
    cb();
};

/*
 * Cleanly stop the stream by killing the child process with a SIGTERM
 */
VmadmCLIEventStream.prototype.stop = function stop() {
    var self = this;

    self.stopped = true;
    self.child.kill();
};

/*
 * Stop the stream and have it dump core.
 */
VmadmCLIEventStream.prototype._abort = function _abort() {
    var self = this;

    self.stopped = true;
    self.log.error({child: self.child.pid},
        '_abort() called - sending SIGABRT');
    self.child.kill('SIGABRT');
    var e = new Error('vmadm aborted');
    self.emit('error', e);
};

module.exports = vmadm;
