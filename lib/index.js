/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var cp = require('child_process');
var fs = require('fs');
var path = require('path');
var spawn = cp.spawn;


var VMADM_PATH = '/usr/sbin/vmadm';

var STDERR_TRUNCATE_LENGTH = 10000;

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
    assert.optionalString(opts.req_id, 'opts.req_id');

    var args = opts.args;
    var child;
    var execOpts = {};
    var stderrBuffer = '';
    var stderrLines = [];
    var stdoutBuffer = '';

    execOpts.env = process.env;
    if (opts.req_id) {
        opts.log.info('setting req_id to %s', opts.req_id);
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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
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

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
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

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
        delete payload.vmadmLogger;
    }

    execOpts.stdinData = JSON.stringify(payload);

    execVmadm(execOpts, function (result, stdout, stderrLines) {
        var info = {};

        if (result.code !== 0 || result.signal !== null) {
            var lastLine = '', lines = '';
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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var args = ['delete', opts.uuid];

    var execOpts = {
        args: args,
        log: opts.log,
        req_id: opts.req_id
    };

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
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

    existsOpts.log = log;
    existsOpts.uuid = opts.uuid;
    existsOpts.include_dni = opts.include_dni;
    delete payload.include_dni;

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
        delete payload.vmadmLogger;
    }

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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
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

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var execOpts = {};
    var existsOpts = {};
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

    existsOpts.log = log;
    existsOpts.uuid = opts.uuid;
    existsOpts.include_dni = opts.include_dni;
    delete payload.include_dni;

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
        delete payload.vmadmLogger;
    }

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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
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

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
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

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
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

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
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

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
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

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
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

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
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

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
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

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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
    assert.optionalObject(opts.vmadmLogger, 'opts.vmadmLogger');
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

    if (opts.vmadmLogger) {
        execOpts.vmadmLogger = opts.vmadmLogger;
    }

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

module.exports = vmadm;
