/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */
'use strict';

const tap = require('tap');
const mp = require('../../lib/machineprop');
const { VError } = require('verror');

class Machine {
    constructor() {
        this.targ = {};
        this.backend = {
            setProp: function () {}
        };
    }
}

function check_verror(t, testcb, name, message) {
    message = message || `${testcb.name} throws VError with name=${name}`;

    try {
        testcb();
        t.ok(false, message);
    } catch (err) {
        var extra = { stack: err.stack };

        t.type(err, VError, message + ' (check type)', extra);
        t.strictSame(name, err.name, message + ' (check message)', extra);
    }
}

tap.test('MachPropArrayOfObjects', function (suite) {
    suite.test('MachPropArrayOfObjects basic set and get', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropArrayOfObjects(mach, 'foo', mach.targ, {});

        var v1 = [];
        prop.set(v1);

        t.strictSame(prop.get(), []);

        // Be sure that the machine has a copy of the array, not the original
        // array.
        v1.push({ say: 'boom'});
        t.strictSame(prop.get(), []);

        prop.set(v1);
        t.strictSame(prop.get(), [{say: 'boom'}]);

        t.end();
    });

    suite.test('MachPropArrayOfObjects unhappy paths', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropArrayOfObjects(mach, 'foo', mach.targ, {});

        check_verror(t, function getUninit() { prop.get(); },
            'ValueRequiredError');

        check_verror(t, function setString() { prop.set('abc'); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set(true); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set(false); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set(null); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set(0); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set(1); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set(['abc']); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set([{}, undefined]); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set([{}, true]); },
            'BadPropertyTypeError');

        // Trying to unset it fails because a value is required, not because of
        // wrong type.
        prop.set([]);
        check_verror(t, function setString() { prop.set(undefined); },
            'ValueRequiredError');

        t.end();
    });

    suite.test('MachPropArrayOfObjects not required property', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropArrayOfObjects(mach, 'nr', mach.targ,
            { required: false });
        var val = [{ blurb: 'ok' }];

        t.strictSame(prop.get(), undefined,
            'get() before set() returns undefined');

        prop.set(val);
        t.strictSame(prop.get(), val, 'set() then get() works as expected');

        t.doesNotThrow(function () { prop.set(undefined); },
            'set(undefined) can clear the value');
        t.strictSame(prop.get(), undefined, 'value cleared');

        t.end();
    });

    suite.end();
});

tap.test('MachPropArrayOfStrings', function (suite) {
    suite.test('MachPropArrayOfStrings basic set and get', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropArrayOfStrings(mach, 'foo', mach.targ, {});

        var v1 = [];
        prop.set(v1);

        t.strictSame(prop.get(), []);

        // Be sure that the machine has a copy of the array, not the original
        // array.
        v1.push('boom');
        t.strictSame(prop.get(), []);

        prop.set(v1);
        t.strictSame(prop.get(), ['boom']);

        t.end();
    });

    suite.test('MachPropArrayOfStrings unhappy paths', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropArrayOfStrings(mach, 'foo', mach.targ, {});

        check_verror(t, function getUninit() { prop.get(); },
            'ValueRequiredError');

        check_verror(t, function setString() { prop.set('abc'); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set(true); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set(false); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set(null); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set(0); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set(1); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set([1]); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set([{}]); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set([{}, undefined]); },
            'BadPropertyTypeError');
        check_verror(t, function setString() { prop.set([{}, true]); },
            'BadPropertyTypeError');

        // Trying to unset it fails because a value is required, not because of
        // wrong type.
        prop.set([]);
        check_verror(t, function setString() { prop.set(undefined); },
            'ValueRequiredError');

        t.end();
    });

    suite.test('MachPropArrayOfStrings not required property', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropArrayOfStrings(mach, 'nr', mach.targ,
            { required: false });
        var val = ['ok'];

        t.strictSame(prop.get(), undefined,
            'get() before set() returns undefined');

        prop.set(val);
        t.strictSame(prop.get(), val, 'set() then get() works as expected');

        t.doesNotThrow(function () { prop.set(undefined); },
            'set(undefined) can clear the value');
        t.strictSame(prop.get(), undefined, 'value cleared');

        t.end();
    });

    suite.end();
});

tap.test('MachPropBool', function (suite) {

    suite.test('MachPropBool true and false', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropBool(mach, 'foo', mach.targ, {});
        prop.set(true);
        t.equal(mach.targ.foo, true);
        t.equal(prop.get(), true);
        prop.set(false);
        t.equal(mach.targ.foo, false);
        t.equal(prop.get(), false);
        t.end();
    });

    suite.test('MachPropBool read-only', function (t) {
        var mach = new Machine();
        var vals = [true, false];
        var prop, val;

        t.plan(10);

        var setVal = function () {
            prop.set(val);
        };
        var setNotVal = function () {
            prop.set(!val);
        };

        while (vals.length > 0) {
            val = vals.pop();
            prop = new mp.MachPropBool(mach, 'foo', mach.targ,
                {writable: false});
            prop.set(val);
            t.equal(mach.targ.foo, val);
            t.throws(setVal, VError, 'property "foo" is read-only');
            t.equal(mach.targ.foo, val);
            t.throws(setNotVal, VError, 'property "foo" is read-only');
            t.equal(mach.targ.foo, val);
        }

        t.end();
    });

    suite.test('MachPropBool validate', function (t) {
        var mach = new Machine();

        class FooError extends Error {
            constructor() {
                super();
            }
        }

        function sticky_if_true(p, v) {
            if (p.target[p.name] === true && v !== true) {
                throw new FooError();
            }
        }

        var prop = new mp.MachPropBool(mach, 'foo', mach.targ,
            { validate: sticky_if_true });
        prop.set(false);
        t.equal(mach.targ.foo, false);
        prop.set(true);
        t.equal(mach.targ.foo, true);
        prop.set(true);
        t.throws(function () { prop.set(false); }, FooError);
        t.end();
    });

    suite.test('MachPropBool bad type', function (t) {
        var mach = new Machine();
        var exp = /^"foo" is of type.*/;

        var prop = new mp.MachPropBool(mach, 'foo', mach.targ, {});
        t.throws(function () { prop.set('true'); }, VError, exp);
        t.throws(function () { prop.set('false'); }, VError, exp);
        t.throws(function () { prop.set(1); }, VError, exp);
        t.throws(function () { prop.set(0); }, VError, exp);
        prop.set(true);
        t.equal(mach.targ.foo, true);
        t.end();
    });

    suite.test('MachPropBool default value', function (t) {
        var mach, prop, dv_called;

        // When a value is not required, no default value is ok
        mach = new Machine();
        prop = new mp.MachPropBool(mach, 'foo', mach.targ, {
            required: false
        });
        t.ok(!mach.targ.hasOwnProperty('foo'));
        t.equal(prop.get(), undefined);
        t.ok(!mach.targ.hasOwnProperty('foo'));

        // When a value is required, no default value is not ok
        mach = new Machine();
        prop = new mp.MachPropBool(mach, 'foo', mach.targ, {
            required: true
        });
        t.ok(!mach.targ.hasOwnProperty('foo'));
        t.throws(function () { prop.get(); }, VError,
            'property "foo" requires a value');
        t.ok(!mach.targ.hasOwnProperty('foo'));

        // The value is initialized from the default by get().
        mach = new Machine();
        prop = new mp.MachPropBool(mach, 'foo', mach.targ, {
            defval: true
        });
        t.ok(!mach.targ.hasOwnProperty('foo'));
        t.equal(prop.get(), true);
        t.equal(mach.targ.foo, true);

        // As previous, but with defval as a function.
        mach = new Machine();
        dv_called = false;
        prop = new mp.MachPropBool(mach, 'foo', mach.targ, {
            required: false,
            defval: function () {
                dv_called = true;
                return true;
            }
        });
        t.ok(!mach.targ.hasOwnProperty('foo'));
        t.equal(prop.get(), true);
        t.equal(mach.targ.foo, true);
        t.ok(dv_called);

        t.end();
    });

    suite.end();
});

tap.test('MachPropObject', function (suite) {

    suite.test('MachPropObject happy path', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropObject(mach, 'foo', mach.targ, {});
        var vals = [ {}, { foo: 'bar' }, { a: true, b: false } ];
        var val;

        for (val in vals) {
            val = vals[val];
            prop.set(val);
            t.strictSame(val, prop.get(), `check ${val}`);
        }

        t.end();
    });

    suite.test('MachPropObject bad types', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropObject(mach, 'foo', mach.targ, {});
        var vals = [ null, 3.14, '1', 'two' ];
        var val;

        function setVal() {
            prop.set(val);
        }

        for (val in vals) {
            val = vals[val];
            check_verror(t, setVal, 'BadPropertyTypeError',
                `BadPropertyTypeError for ${val}`);
        }
        t.end();
    });

    suite.end();
});

tap.test('MachPropDynamic', function (suite) {

    suite.test('MachPropDynamic happy paths', function (t) {
        var mach = new Machine();
        var expect;
        var prop = new mp.MachPropDynamic(mach, 'foo', {
            getter: function testGetter(gProp) {
                t.strictSame(prop, gProp);
                return expect;
            }
        });

        var vals = [undefined, true, false, 1, 2, {}, 'blah', ['a', 'b']];
        for (var val in vals) {
            expect = vals[val];
            t.strictSame(prop.get(), expect);
        }

        t.end();
    });

    suite.test('MachPropDynamic sad paths', function (t) {
        var mach = new Machine();
        var expect;
        var prop;

        function getter(_prop) {
            return expect;
        }

        t.throws(function tooManyArgs() {
            prop = new mp.MachPropDynamic(mach, 'foo', mach.targ,
                { getter: getter });
        }, /Invalid signature:/);

        t.throws(function noGetter() {
            prop = new mp.MachPropDynamic(mach, 'foo', {});
        }, /opts\.getter/);

        t.throws(function requiredNotAllowed() {
            prop = new mp.MachPropDynamic(mach, 'foo', {
                getter: getter,
                required: true
            });
        }, /opts\.required/);

        t.throws(function writableNotAllowed() {
            prop = new mp.MachPropDynamic(mach, 'foo', {
                getter: getter,
                writable: true
            });
        }, /opts\.writable/);

        prop = new mp.MachPropDynamic(mach, 'foo', { getter: getter });

        check_verror(t, function setDynamic() { prop.set('something'); },
            'ReadOnlyPropertyError');

        t.end();
    });

    suite.end();
});

tap.test('MachPropInteger', function (suite) {

    suite.test('MachPropInteger happy path', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropInteger(mach, 'foo', mach.targ, {});
        var vals = [ -1, 0, 1,
            2147483648,             // 2**31
            4294967296,             // 2**32
            Number.MAX_SAFE_INTEGER
        ];

        var val;

        for (val in vals) {
            val = vals[val];
            prop.set(val);
            t.strictSame(val, prop.get(), `check ${val}`);
        }

        t.end();
    });

    suite.test('MachPropInteger bad types', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropInteger(mach, 'foo', mach.targ, {});
        var vals = [ null, 3.14, '1', 'two' ];
        var val;

        function setVal() {
            prop.set(val);
        }

        for (val in vals) {
            val = vals[val];
            check_verror(t, setVal, 'BadPropertyTypeError',
                `BadPropertyTypeError for ${val}`);
        }
        t.end();
    });

    suite.test('MachPropInteger limits', function (t) {
        var mach = new Machine();
        var prop, val;

        // Check values when min and max are backwards
        t.throws(function minMoreThanMax() {
            prop = new mp.MachPropInteger(mach, 'foo', mach.targ, {
                min: 4,
                max: 0
            }, /min must be less than or equal to max/);
        });

        // Check values when min and max set and equal
        t.doesNotThrow(function minSameAsMax() {
            prop = new mp.MachPropInteger(mach, 'foo', mach.targ, {
                min: 4,
                max: 4
            });
        });
        prop.set(4);
        t.strictSame(4, prop.get());
        check_verror(t, function smallerThanFour() { prop.set(3); },
            'BadPropertyRangeError');
        check_verror(t, function largerThanFour() { prop.set(5); },
            'BadPropertyRangeError');

        // Check values when min and max set, but not equal
        prop = new mp.MachPropInteger(mach, 'foo', mach.targ, {
            min: 32,
            max: 1024
        });
        var vals = [32, 42, 1024];
        for (val in vals) {
            val = vals[val];
            prop.set(val);
            t.strictEqual(val, prop.get());
        }
        check_verror(t, function tooSmall() { prop.set(5); },
            'BadPropertyRangeError');
        check_verror(t, function tooBig() { prop.set(1025); },
            'BadPropertyRangeError');

        // Numbers are stored as floats so not all 64-bit numbers can be
        // represented.
        prop = new mp.MachPropInteger(mach, 'foo', mach.targ, {});
        check_verror(t, function smallerThanSafe() {
            prop.set(Number.MIN_SAFE_INTEGER - 1);
        }, 'BadPropertyRangeError');
        check_verror(t, function largerThanSafe() {
            prop.set(Number.MAX_SAFE_INTEGER + 1);
        }, 'BadPropertyRangeError');

        t.end();
    });

    suite.end();
});

tap.test('MachPropISO8601', function (suite) {

    suite.test('MachPropISO8601 happy path', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropISO8601(mach, 'foo', mach.targ, {});

        var val = '2020-04-01T12:34:56Z';
        prop.set(val);
        t.strictSame(val, prop.get());

        var last_time;

        function now() {
            var time = new Date();
            last_time = time.toISOString().split('.')[0] + 'Z';
            return last_time;
        }

        val = now();
        prop.set(val);
        t.strictSame(val, prop.get());

        prop = new mp.MachPropISO8601(mach, 'foo', mach.targ,
            { defval: now });
        t.strictSame(last_time, prop.get());

        t.end();
    });

    suite.test('MachPropISO8601 bad types', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropISO8601(mach, 'foo', mach.targ, {});
        var vals = [ new Date(), '20200401T123456Z' ];
        var val;

        function setVal() {
            prop.set(val);
        }

        for (val in vals) {
            val = vals[val];
            t.throws(setVal);
        }
        t.end();
    });

    suite.end();
});

tap.test('MachPropUUID', function (suite) {

    suite.test('MachPropUUID happy path', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropUUID(mach, 'foo', mach.targ, {});

        var val = 'e5904cd1-a5f6-c023-e86b-8fb38bca6595';
        prop.set(val);
        t.strictSame(val, prop.get());

        t.end();
    });

    suite.test('MachPropUUID bad types', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropUUID(mach, 'foo', mach.targ, {});
        var vals = [ null,                              // not a string
            'e5904cd1-a5f6-c023-e86b-8fb38bca659',      // too short
            ' e5904cd1-a5f6-c023-e86b-8fb38bca6595',    // leading space
            'e5904cd1-a5f6-c023-e86b-8fb38bca6595 ',    // trailing space
            'e5904cd1-a5f6-c023-e86b-8fb38bca6595-',    // trailing hyphen
            'e5904cd1-a5f6-c023-e86b-8fb38bca6595a',    // trailing hexdigit
            '0e5904cd1-a5f6-c023-e86b-8fb38bca6595',    // leading hexdigit
            'E5904CD1-A5F6-C023-E86B-8FB38BCA6595',     // uppercase
            'e5904cd1a5f6c023e86b8fb38bca6595',         // no hhypens
            'g5904cd1-a5f6-c023-e86b-8fb38bca6595',     // not a hexdigit
            [ 'e5904cd1-a5f6-c023-e86b-8fb38bca6595' ]  // not a string
        ];
        var val;

        function setVal() {
            prop.set(val);
        }

        for (val in vals) {
            val = vals[val];
            check_verror(t, setVal, 'BadPropertyTypeError',
                `BadPropertyTypeError for "${val}"`);
        }
        t.end();
    });

    suite.end();
});

tap.test('MachPropString', function (suite) {

    suite.test('MachPropString happy path', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropString(mach, 'foo', mach.targ, {});

        var val = 'stuff';
        prop.set(val);
        t.strictSame(val, prop.get());

        val = '';
        prop.set(val);
        t.strictSame(val, prop.get());

        function upSetter(p, value) {
            p.target[p.name] = value.toUpperCase();
        }

        prop = new mp.MachPropString(mach, 'foo', mach.targ, {
            setter: upSetter
        });
        t.doesNotThrow(prop.set('abc'), 'set "abc" with upSetter');
        t.strictSame('ABC', prop.get(), 'get "ABC"');

        t.end();
    });

    suite.test('MachPropString bad types', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropString(mach, 'foo', mach.targ, {});
        var vals = [ null, 1, /abc/, [ 'abc' ], true, false ];
        var val;

        function setVal() {
            prop.set(val);
        }

        for (val in vals) {
            val = vals[val];
            check_verror(t, setVal, 'BadPropertyTypeError',
                `BadPropertyTypeError for "${val}"`);
        }
        t.end();
    });

    suite.test('MachPropString length checks', function (t) {
        var mach = new Machine();
        var prop = new mp.MachPropString(mach, 'foo', mach.targ, {
            min: 1,
            max: 5
        });
        var val, vals;

        function setVal() {
            prop.set(val);
        }

        vals = [ '1', '12', '123', '1234', '12345',
            'a', 'ab', 'abc', 'abcd', 'abcde' ];
        for (val in vals) {
            val = vals[val];
            t.doesNotThrow(setVal, `foo="${val}"`);
            t.strictSame(val, prop.get());
        }

        vals = [ '', '123456' ];
        for (val in vals) {
            val = vals[val];
            check_verror(t, setVal, 'BadPropertyRangeError',
                `BadPropertyRangeError for "${val}"`);
        }

        t.end();
    });

    suite.end();
});
