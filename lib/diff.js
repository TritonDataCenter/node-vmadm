/*
 * CDDL HEADER START
 *
 * The contents of this file are subject to the terms of the
 * Common Development and Distribution License, Version 1.0 only
 * (the "License").  You may not use this file except in compliance
 * with the License.
 *
 * You can obtain a copy of the license at http://smartos.org/CDDL
 *
 * See the License for the specific language governing permissions
 * and limitations under the License.
 *
 * When distributing Covered Code, include this CDDL HEADER in each
 * file.
 *
 * If applicable, add the following below this CDDL HEADER, with the
 * fields enclosed by brackets "[]" replaced with your own identifying
 * information: Portions Copyright [yyyy] [name of copyright owner]
 *
 * CDDL HEADER END
 *
 * Copyright (c) 2018, Joyent, Inc.
 *
 * "diff" 2 JavaScript objects
 *
 * var a = {
 *     foo: true,
 *     num: 1
 * };
 * var b = {
 *     bar: true,
 *     num: 2
 * };
 * var changes = diff(a, b);
 * console.log(changes);
 * [
 *   {
 *     "prettyPath": "foo",
 *     "path": ["foo"],
 *     "action": "removed",
 *     "oldValue": true
 *   },
 *   {
 *     "prettyPath": "num",
 *     "path": ["num"],
 *     "action": "changed",
 *     "oldValue": 1,
 *     "newValue": 2
 *   },
 *   {
 *     "prettyPath": "bar",
 *     "path": ["bar"],
 *     "action": "added",
 *     "newValue": true
 *   }
 * ]
 *
 * On top of this basic functionality, this function also supports comparing
 * objects for modifications based on an "identifierKey" supplied in a map.
 *
 * Consider the following two objects.
 *
 * var a = {
 *     disks: [
 *         {
 *             name: "foo",
 *             size: 10
 *         }
 *     ]
 * };
 * var b = {
 *     disks: [
 *         {
 *             name: "foo",
 *             size: 20
 *         }
 *     ]
 * };
 *
 * Looking at these objects, we can see that the "disks" array has a single
 * object with both a name and size - only the size has changed from 10 to 20.
 * Running these objects through diff() without a map yields:
 *
 * var changes = diff(a, b);
 * console.log(changes);
 * [
 *   {
 *     "prettyPath": "disks.*",
 *     "path": [
 *       "disks",
 *       null
 *     ],
 *     "action": "removed",
 *     "oldValue": {
 *       "name": "foo",
 *       "size": 10
 *     }
 *   },
 *   {
 *     "prettyPath": "disks.*",
 *     "path": [
 *       "disks",
 *       null
 *     ],
 *     "action": "added",
 *     "newValue": {
 *       "name": "foo",
 *       "size": 20
 *     }
 *   }
 * ]
 *
 * Note that `null` in the `path` array means any element of the array, as
 * this module doesn't concern itself with the indices of an array or array
 * sort order.
 *
 * diff() reports that an entire object was removed from the "disks" array
 * and replaced with a new object.  If we know ahead of time that a key
 * (like "disks") is guaranteed to be an array of objects, we can give diff()
 * a "map" where we can specify that "disks" -> "name"... meaning "disks"
 * is an array of objects where "name" is a key that represents a unique
 * identifier for the object.  This way, we can determine if an object
 * was removed completely, or just modified in place.
 *
 * var map = {
 *     disks: 'name'
 * };
 * var changes = diff(a, b, {map: map});
 * console.log(changes);
 * [
 *   {
 *     "prettyPath": "disks.*.size",
 *     "path": [
 *       "disks",
 *       null,
 *       "size"
 *     ],
 *     "action": "changed",
 *     "oldValue": 10,
 *     "newValue": 20,
 *     "ident": "foo"
 *   }
 * ]
 *
 * With the map supplied, only one change is reported (the size).  The "ident"
 * key shows the value of the identifierKey for the object modified (in this
 * case, the value of the disks "name" attribute).
 *
 * The keys given in the "map" object are only applied to the base object
 * given, meaning an initial object like this won't use the map.
 *
 * var a = {
 *     "root": {
 *         "disks": [
 *             {
 *                 "name": "foo"
 *             }
 *         ]
 *     }
 * };
 *
 * As the base key considered by the map in this example is "root".
 *
 */

var assert = require('assert-plus');

/*
 * This is the entry point into this module.
 *
 * This function will determine the appropriate internal diffing function to
 * call based on the input paramaters.
 *
 * The folliwng data types are supported by this module.
 *
 * - Primitives (number, string, boolean)
 * - Array
 * - Object
 * - Date
 * - null
 * - undefined
 *
 * Any other data type may or may not yield unexpected results.
 *
 * opts is an optional object that may contain
 *
 *   - opts.map    A key->value mapping used for determining object differencs,
 *                 more information about this can be found in this files block
 *                 comment
 *   - opts.prefix An array to keep track of how deep into an object we
 *                 currently are.  This variable is created and maintaned by
 *                 the internal diffing functions like objDiff and arrayDiff
 *                 and should not be provided by the caller.
 */
function diff(a, b, _opts) {
    if (theSameValue(a, b)) {
        return [];
    } else if (Array.isArray(a) && Array.isArray(b)) {
        return arrayDiff.apply(this, arguments);
    } else {
        return objDiff.apply(this, arguments);
    }
}

/*
 * Compare two objects - called by diff()
 *
 * opts is the same object document in the diff() function
 */
function objDiff(a, b, opts) {
    var changes = [];
    var prefix;

    opts = opts || {};
    opts.map = opts.map || {};
    prefix = opts.prefix || [];

    assert.object(opts, 'opts');
    assert.object(opts.map, 'opts.map');
    assert.array(prefix, 'prefix');

    if (theSameValue(a, b))
        return [];

    assert.object(a, 'a');
    assert.object(b, 'b');

    // loop all keys on the a (from) side
    Object.keys(a).forEach(function loopFromObject(key) {
        var nestOpts = {};
        var path = prefix.concat(key);
        var prettyPath = toDotNotation(path);

        // if the key is not in b, it was removed
        if (!hasProperty(b, key)) {
            changes.push({
                prettyPath: prettyPath,
                path: path,
                action: 'removed',
                oldValue: a[key]
            });
            return;
        }

        // if the value in a is the same as the value in b, there was no change
        // so we move on
        if (theSameValue(a[key], b[key]))
            return;

        // if either key in a or b is not an object, then the value has changed
        if (typeof (a[key]) !== 'object' || typeof (b[key]) !== 'object') {

            changes.push({
                prettyPath: prettyPath,
                path: path,
                action: 'changed',
                oldValue: a[key],
                newValue: b[key]
            });

            return;
        }

        // both values are objects (maybe Array), compare recursively
        Object.keys(opts).forEach(function loopOpts(k) {
            nestOpts[k] = opts[k];
        });
        nestOpts.prefix = path;

        diff(a[key], b[key], nestOpts, key).forEach(
            function loopNestedChanges(change) {

            changes.push(change);
        });
    });

    // loop all keys in the b (to) side to find any additions
    Object.keys(b).forEach(function loopToObject(key) {
        if (hasProperty(a, key))
            return;

        var path = prefix.concat(key);
        var prettyPath = toDotNotation(path);

        changes.push({
            prettyPath: prettyPath,
            path: path,
            action: 'added',
            newValue: b[key]
        });
    });

    return changes;
}

/*
 * Compare two arrays - called by diff()
 *
 * opts is the same object document in the diff() function
 *
 * key is optional and not to be passed by the consumer.  If key is set, it
 * means the array we are currently calculating the differences for was nested
 * inside an object under this key.  Using this information, we can determine
 * if the "map" (if set) should be used to calculate differences.
 */
function arrayDiff(a, b, opts, key) {
    var aSerialized;
    var bSerialized;
    var changes = [];
    var identifierKey;
    var modified = [];
    var path;
    var possiblyAdded = [];
    var possiblyRemoved = [];
    var prefix;
    var prettyPath;

    opts = opts || {};
    opts.map = opts.map || {};
    prefix = opts.prefix || [];

    assert.array(a, 'a');
    assert.array(b, 'b');
    assert.object(opts, 'opts');
    assert.object(opts.map, 'opts.map');
    assert.array(prefix, 'prefix');

    // because we are inside an array, we add `null` to the end of the current
    // path.
    path = prefix.concat(null);
    prettyPath = toDotNotation(path);

    // check if we should use the "map" for this array
    if (key && path.length === 2 && hasProperty(opts.map, key))
        identifierKey = opts.map[key];

    // serialize everything in a and b to compare directly as strings
    aSerialized = a.map(function serializeArrayA(o) {
        return JSON.stringify(o);
    });
    bSerialized = b.map(function serializeArrayB(o) {
        return JSON.stringify(o);
    });

    // all values in a not found in b have been possibly removed
    aSerialized.forEach(function checkRemoved(o, i) {
        if (bSerialized.indexOf(o) >= 0)
            return;

        possiblyRemoved.push(i);
    });

    // all values in b not found in a have been possibly added
    bSerialized.forEach(function checkAdded(o, j) {
        if (aSerialized.indexOf(o) >= 0)
            return;

        possiblyAdded.push(j);
    });

    // if an identifierKey is found - meaning the arrays we are looking at
    // were found inside an object with a given "key" (4th arg), we treat
    // every element inside the array as an object, and look for an
    // "identifier" object to compare
    if (identifierKey) {
        possiblyRemoved = possiblyRemoved.filter(function filterRemoved(i) {
            var found = false;
            var oi = a[i];

            assert.object(oi, 'must be an object: ' + JSON.stringify(oi));

            possiblyAdded = possiblyAdded.filter(function filterAdded(j) {
                var oj = b[j];

                assert.object(oi, 'must be an object');

                if (found)
                    return true;

                if (oi[identifierKey] === oj[identifierKey]) {
                    found = true;

                    // to be processed recursively below
                    modified.push({
                        a: oi,
                        b: oj,
                        ident: oi[identifierKey]
                    });
                    return false;
                }

                return true;
            });

            return !found;
        });
    }

    // add the changes to the changes array to be returned
    possiblyRemoved.forEach(function pushRemovedChanges(i) {
        changes.push({
            prettyPath: prettyPath,
            path: path,
            action: 'removed',
            oldValue: a[i]
        });
    });
    modified.forEach(function pushModifiedChanges(mod) {
        // mod.a and mod.b are guaranteed to be objects
        var _changes = objDiff(mod.a, mod.b, {prefix: path});
        _changes.forEach(function pushModifiedChange(change) {
            change.ident = mod.ident;
            changes.push(change);
        });
    });
    possiblyAdded.forEach(function pushAddedChanges(j) {
        changes.push({
            prettyPath: prettyPath,
            path: path,
            action: 'added',
            newValue: b[j]
        });
    });

    return changes;
}

/*
 * Check if 2 primitive values are the same
 */
function theSameValue(a, b) {
    if (a === b)
        return true;

    if (a instanceof Date && b instanceof Date)
        return theSameValue(a.getTime(), b.getTime());

    return false;
}

/*
 * Convert a "path" (given as an array) to a pretty-formatted dot-notation
 * string. This is solely meant for producing a human-readable path in the
 * "changes" array given from any object or array diff.  Examples
 *
 * > toDotNotation(['disks', 0, 'name'])
 * => 'disks.0.name'
 *
 * > toDotNotation(['disks', null, 'name']);
 * => 'disks.*.name'
 *
 * > toDotNotation(['nics', '192.168.1.1', 'name'])
 * => 'nics[192.168.1.1].name'
 *
 */
function toDotNotation(arr) {
    var s = '';

    assert.array(arr, 'arr');

    arr.forEach(function loopPathElements(elem) {
        if (elem === null)
            elem = '*';
        elem = '' + elem;

        // eslint-disable-next-line
        if (elem.match(/[\.\[\]]/)) {
            // eslint-disable-next-line
            elem = elem.replace(/([\[\]])/g, '\\$1');
            s += '[' + elem + ']';
            return;
        }

        if (s.length > 0)
            s += '.';
        s += elem;
    });
    return s;
}

/*
 * safe hasOwnProperty
 */
function hasProperty(o, p) {
    return ({}).hasOwnProperty.call(o, p);
}

module.exports = diff;

function main() {
    var read = require('fs').readFileSync;
    var a = JSON.parse(read(process.argv[2]));
    var b = JSON.parse(read(process.argv[3]));

    var opts;
    if (process.argv[4])
        opts = JSON.parse(read(process.argv[4]));
    var key = process.argv[5];

    var changes = diff(a, b, opts, key);
    console.log(JSON.stringify(changes, null, 2));
}

if (require.main === module)
    main();
