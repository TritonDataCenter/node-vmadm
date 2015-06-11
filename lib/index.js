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

/*
 * Execute vmadm
 *
 * @param opts {Object} Options
 *      - args {Array} cmdline args for vmadm
 *      - log {Logger object}
 *      - req_id {String} request id for this request (to tie to callers)
 *      - vmadmLogger {Object} with a .write() method that takes a single object
 *        as its argument. vmadm evt logs go here.
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

    var args = opts.args;
    var child;
    var execOpts = {env: {}};
    var stderrBuffer = '';
    var stderrLines = [];
    var stdoutBuffer = '';

    if (opts.req_id) {
        opts.log.info('setting req_id to %s', opts.req_id);
        execOpts.env.REQ_ID = opts.req_id;
    }
    execOpts.env.VMADM_DEBUG_LEVEL = 'debug';
    if (process.env.EXPERIMENTAL_VMJS_TRACING) {
        execOpts.env.EXPERIMENTAL_VMJS_TRACING =
            process.env.EXPERIMENTAL_VMJS_TRACING;
    }

    opts.log.info({ args: args, execOpts: execOpts }, 'executing vmadm');

    child = spawn(VMADM_PATH, args, execOpts);

    child.stdout.on('data', function _childStdoutHandler(data) {
        stdoutBuffer += data.toString();
    });

    child.stderr.on('data', function _childStderrHandler(data) {
        var chunk;
        var chunks;
        var logobj;

        stderrBuffer += data.toString();
        chunks = stderrBuffer.split('\n');
        while (chunks.length > 1) {
            chunk = chunks.shift();

            // log the record to the vmadmLogger if it's an evt log.
            logobj = undefined;
            if (opts.vmadmLogger) {
                if (chunk[0] === '{' && chunk.indexOf('"evt"') !== -1) {
                    try {
                        logobj = JSON.parse(chunk);
                    } catch (e) {
                        opts.log.warn({line: chunk, err: e},
                            'failed to JSON.parse line');
                    }
                }
            }
            if (logobj) {
                opts.vmadmLogger.write(logobj);
            }

            stderrLines.push(chunk);
        }
        stderrBuffer = chunks.pop();
    });

    child.on('close', function _childCloseHandler(code, signal) {
        if (stderrBuffer.length > 0) {
            opts.log.info('stderr from vmadm: ' + stderrBuffer);
            stderrLines.push(stderrBuffer);
        }

        opts.log.info('vmadm child closed with (%d, %d)', code, signal);

        if (code !== 0 || signal !== null) {
            opts.log.error({
                code: code,
                signal: signal,
                cmdline: [VMADM_PATH].concat(args),
                stdout: stdoutBuffer,
                stderrLines: stderrLines
            }, 'error executing vmadm');
        }

        callback({code: code, signal: signal}, stdoutBuffer, stderrLines);
    });

    if (opts.stdinData) {
        child.stdin.write(opts.stdinData);
    }
    child.stdin.end();
}


/**
 * Call `vmadm lookup -1 -j UUID`.
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
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalString(opts.req_id, 'opts.req_id');

    if (!callback) {
        callback = vmopts;
    }

    function addargs(newargs) {
        Array.prototype.push.apply(args, newargs);
    }

    var args = ['lookup', '-1', '-j'];

    if (vmopts && vmopts.fields) {
        addargs(['-o', vmopts.fields.join(',')]);
    }

    args.push('uuid=' + opts.uuid);

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

    opts.log.info('spawning vmadm for load');

    execVmadm(execOpts, function (result, stdout, stderrLines) {
        var err;
        var vm;
        var vms;

        if (result.code !== 0 || result.signal !== null) {
            if (stderrLines[stderrLines.length - 1].match(/found 0 results/)) {
                // NOTE: destroy depends on this matching ': No such zone'
                err = new Error('vmadm lookup ' + opts.uuid +
                    ' failed: No such zone');
            } else {
                err = new Error('vmadm exited with code: ' + result.code +
                    ' signal: ' + result.signal + ' -- ' +
                    stderrLines.join('\n'));
            }
            err.stderr = stderrLines.join('\n');
            return callback(err);
        }

        try {
            vms = JSON.parse(stdout);
        } catch (jsonErr) {
            jsonErr.stdout = stdout;
            return callback(jsonErr);
        }

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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.string(opts.req_id, 'opts.req_id');

    var execOpts = {};
    var log = opts.log;
    var payload = opts;
    delete payload.log;

    log.info('spawning vmadm for create');

    execOpts.log = log;
    execOpts.args = ['create'];
    execOpts.req_id = opts.req_id;
    delete payload.req_id;

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
        delete payload.vmadmLogger;
    }

    execOpts.stdinData = JSON.stringify(payload);

    execVmadm(execOpts, function (result, stdout, stderrLines) {
        if (result.code !== 0 || result.signal !== null) {
            callback(new Error(stderrLines.join('\n').trim()));
            return;
        }
        callback();
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
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.string(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');

    var args = ['delete', opts.uuid];

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

    opts.log.info('spawning vmadm for delete');

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
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.string(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');

    var execOpts = {};
    var log = opts.log;
    var payload = opts;
    delete payload.log;

    log.info('spawning vmadm for machine update');

    execOpts.log = log;
    execOpts.args = ['update', opts.uuid];
    execOpts.req_id = opts.req_id;
    delete payload.req_id;

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
        delete payload.vmadmLogger;
    }

    execOpts.stdinData = JSON.stringify(payload);

    execVmadm(execOpts, function (result, stdout, stderrLines) {
        if (result.code !== 0 || result.signal !== null) {
            callback(new Error(stderrLines.join('\n').trim()));
            return;
        }
        callback();
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
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.string(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');

    var args = ['reboot', opts.uuid];

    if (opts.force) {
        args.push('-F');
    }

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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
};



/**
 * Call `vmadm reprovision`.
 *
 * @param opts {Object} VMADM reprovision payload
 *      - log {Logger object}
 *      - uuid {String} uuid of vm to be reprovisioned
 * @param callback {Function} `function (err)`
 */

vmadm.reprovision = function vmReprovision(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.string(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');

    var execOpts = {};
    var log = opts.log;
    var payload = opts;
    delete payload.log;

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
        delete payload.vmadmLogger;
    }

    execOpts.log = log;
    execOpts.args = ['reprovision', opts.uuid];
    execOpts.req_id = opts.req_id;
    delete payload.req_id;

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
        delete payload.vmadmLogger;
    }

    execOpts.stdinData = JSON.stringify(payload);

    execVmadm(execOpts, function (result, stdout, stderrLines) {
        if (result.code !== 0 || result.signal !== null) {
            callback(new Error(stderrLines.join('\n').trim()));
            return;
        }
        callback();
    });
};



/**
 * Call `vmadm lookup -j`.
 *
 * @param opts {Object} Options
 *      - uuid {String} The VM uuid.
 *      - log {Logger object}
 * @param vmopts {Object} Optional vm options
 *      - fields {Array} Return only the keys give in `fields` array
 * @param callback {Function} `function (err)`
 */

vmadm.lookup = function vmLookup(search, options, callback) {
    assert.object(search, 'search');
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.optionalObject(options.vmadmLogger, 'options.vmadmLogger');
    assert.optionalString(options.req_id, 'options.req_id');

    function addargs(newargs) {
        Array.prototype.push.apply(args, newargs);
    }

    var args = ['lookup', '-j'];

    if (options && options.fields) {
        addargs(['-o', options.fields.join(',')]);
    }

    Object.keys(search).forEach(function (name) {
        args.push(name + '=' + search[name]);
    });

    var execOpts = {
        args: args,
        log: options.log,
        req_id: options.req_id
    };

    if (options.vmadmLogger) {
        execOpts.vmadmLogger = options.vmadmLogger;
    }

    execVmadm(execOpts, function (result, stdout, stderrLines) {
        var err;

        if (result.code !== 0 || result.signal !== null) {
            err = new Error('vmadm exited with code: ' + result.code +
                ' signal: ' + result.signal + ' -- ' +
                stderrLines.join('\n'));
            err.stderr = stderrLines.join('\n');
            return callback(err);
        }

        var vms;

        try {
            vms = JSON.parse(stdout);
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
 * @param callback {Function} `function (err)`
 */

vmadm.kill = function vmKill(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.string(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalString(opts.signal, 'opts.signal');

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

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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
};



/**
 * Call `vmadm info <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of KVM to run info on
 *      - log {Logger object}
 *      - types {Array of Strings} Optional array of type strings
 * @param callback {Function} `function (err)`
 */

vmadm.info = function vmInfo(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.string(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalArrayString(opts.types, 'opts.types');

    var args = ['info', opts.uuid];

    if (opts.types) {
        args.push(opts.types.join(','));
    }

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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
};



/**
 * Call `vmadm sysrq <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of KVM to run sysrq on
 *      - log {Logger object}
 *      - req {String} Type of request, 'screenshot' or 'nmi'
 * @param callback {Function} `function (err)`
 */

vmadm.sysrq = function vmSysrq(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.string(opts.req_id, 'opts.req_id');
    assert.string(opts.req, 'opts.req');
    assert.string(opts.uuid, 'opts.uuid');

    var args = ['sysreq', opts.uuid, opts.req];

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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
};



/**
 * Call `vmadm create-snapshot <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID VM to snapshot
 *      - log {Logger object}
 *      - snapshot_name {String} name to give the snapshot
 * @param callback {Function} `function (err)`
 */

vmadm.create_snapshot = function vmCreateSnapshot(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.string(opts.req_id, 'opts.req_id');
    assert.string(opts.snapshot_name, 'opts.snapshot_name');
    assert.string(opts.uuid, 'opts.uuid');

    var args = ['create-snapshot', opts.uuid, opts.snapshot_name];

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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

};



/**
 * Call `vmadm rollback-snapshot <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM container snapshot to rollback
 *      - log {Logger object}
 *      - snapshot_name {String} name of snapshot to rollback
 * @param callback {Function} `function (err)`
 */

vmadm.rollback_snapshot = function vmRollbackSnapshot(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.string(opts.req_id, 'opts.req_id');
    assert.string(opts.snapshot_name, 'opts.snapshot_name');
    assert.string(opts.uuid, 'opts.uuid');

    var args = ['rollback-snapshot', opts.uuid, opts.snapshot_name];

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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

};



/**
 * Call `vmadm delete-snapshot <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM container snapshot to delete
 *      - log {Logger object}
 *      - snapshot_name {String} name of the snapshot to delete
 * @param callback {Function} `function (err)`
 */

vmadm.delete_snapshot = function vmDeleteSnapshot(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.string(opts.req_id, 'opts.req_id');
    assert.string(opts.snapshot_name, 'opts.snapshot_name');
    assert.string(opts.uuid, 'opts.uuid');

    var args = ['delete-snapshot', opts.uuid, opts.snapshot_name];

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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

};



/**
 * Call `vmadm start <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to start
 *      - log {Logger object}
 * @param callback {Function} `function (err)`
 */

vmadm.start = function vmStart(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.string(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');

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

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

    opts.log.info('spawning vmadm for start');

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
};



/**
 * Call `vmadm stop <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to stop
 *      - force {Boolean} Whether to force the stop
 *      - log {Logger object}
 * @param callback {Function} `function (err)`
 */

vmadm.stop = function vmStop(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.string(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');

    var args = ['stop', opts.uuid];

    if (opts.force) {
        args.push('-F');
    }

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

    opts.log.info('spawning vmadm for stop');

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
};

module.exports = vmadm;
