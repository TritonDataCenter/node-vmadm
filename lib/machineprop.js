/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */


const assert = require('assert-plus');
const deepcopy = require('deepcopy');
const { VError } = require('verror');

/**
 * A Machine Property
 * @class MachProp
 * @classdesc This is intended to be a base class for other property classes. A
 * MachProp encapsulates getters, setters, and validators for properties of
 * different types.
 */
class MachProp {
    /**
     * @param {Machine} machine - The machine with which this property is
     *        associated.
     * @param {string} name - The name of the property.
     * @param {(Object|null)} target - The object that will store the value.
     *        That is, target[name] will store the value of this property.
     * @param {(string|null)} type - The type of the value. Use null if
     *        opts.validate provides type checking that is better than comparing
     *        against typeof.
     * @param {Object} opts - Options
     * @param {boolean} opts.required - Does the machine require this property
     *        to be set?
     * @param {boolean} opts.writable - If false, only the first invocation of
     *        set() will be allowed.
     * @param {function} opts.getter - A callback that will be called as
     *        opts.getter(this) to get the value.
     * @param {function} opts.setter - A callback that will be called as
     *        opts.setter(this, value) to set the value.
     * @param {function} opts.validate - A callback that will be called as
     *        opts.validate(this, value) to validate the value before setting
     *        it.
     * @param {(function|*)} opts.defval - If it is a function, will be
     *        called by Machine.validate() to generate the default value.  If
     *        opts.defval is set and not a function, it contains the default
     *        value for the property.  The default value is (perhaps generated
     *        and then) used when Machine.validate() is called and the property
     *        does not have a value.
     */
    constructor(machine, name, type, target, opts) {
        assert.strictEqual(arguments.length, 5,
            'Invalid signature: MachProp(machine, name, type, target, opts)');
        assert.object(machine, 'machine');
        assert.string(name, 'name');
        assert.optionalString(type, 'type');
        assert.optionalObject(target, 'target');
        assert.object(opts, 'opts');
        assert.optionalBool(opts.required, 'opts.required');
        assert.optionalFunc(opts.getter, 'opts.getter');
        assert.optionalFunc(opts.setter, 'opts.setter');
        assert.optionalFunc(opts.validate, 'opts.validate');

        var self = this;

        self.machine = machine;
        self.name = name;
        self.type = type;
        self.target = target;
        self.required = opts.hasOwnProperty('required') ? opts.required : true;
        self.writable = opts.hasOwnProperty('writable') ? opts.writable : true;
        self.initialized = false;
        self.opts = opts;
        self.value = undefined;
        self.getter = opts.getter;
        self.setter = opts.setter;

        if (opts.hasOwnProperty('defval')) {
            self.defval = opts.defval;
        }

        if (opts.getter) {
            self.getter = opts.getter;
        } else {
            assert.object(target);
            self.getter = function get() {
                return self.target[self.name];
            };
        }

        if (opts.setter) {
            self.setter = opts.setter;
        } else if (opts.writable) {
            assert.object(target);
            self.setter = function set(value) {
                if (self.value !== undefined && self.type !== null) {
                    assert.strictEqual(typeof (value), self.type, 'self.type');
                }
                self.target[self.name] = value;
            };
        }
    }

    /**
     * Get the value of self MachProp.
     * @returns {*} The value returned by self.getter() or the value
     * stored in self MachProp if no getter is defined.
     */
    get() {
        assert.strictEqual(arguments.length, 0,
            'Invalid signature: MachineProp.get()');
        var self = this;

        if (!self.initialized) {
            self.validate_default();
        }
        if (self.getter) {
            return self.getter(self);
        }
        return self.target[self.name];
    }

    /**
     * Set the value of this MachProp.
     * @param {*} value - The value to assign, perhaps via self.setter().
     * @throws {*} See validate().
     */
    set(value) {
        assert.strictEqual(arguments.length, 1,
            'Invalid signature: MachineProp.set(value)');
        var self = this;

        if (self.copy) {
            value = self.copy(value);
        }

        if (!self.writable && self.initialized) {
            throw new VError({
                name: 'ReadOnlyPropertyError',
                info: self.name,
                last_set: self.last_set
            }, 'property "%s" is read-only', self.name);
        }
        self.validate(value);

        if (self.setter) {
            self.setter(self, value);
        } else {
            self.target[self.name] = value;
        }

        self.machine.backend.setProp(self.name, value, {
            ignore_errors: [ 'NoBackendPropertyError', 'ReadOnlyPropertyError' ]
        });
        var e = new Error();
        self.last_set = e.stack.replace(/^Error\n/, 'Last set by:');

        self.initialized = (value !== undefined);
    }

    /**
     * Validate the value of this MachProp.
     * @param {*} value - The value to validate.
     * @throws {AssertionError} If value is undefined or does not match the
     * expected type.
     * @throws {*} As determined by any validate() callback passed to the
     * constructor.
     */
    validate(value) {
        assert.strictEqual(arguments.length, 1,
            'Invalid signature: MachineProp.validate(value)');
        var self = this;

        if (value === undefined) {
            if (self.required) {
                throw new VError({
                    name: 'ValueRequiredError',
                    info: self.name
                }, 'property "%s" requires a value', self.name);
            }
        } else {
            if (self.type && typeof (value) !== self.type) {
                throw new VError({
                    name: 'BadPropertyTypeError',
                    info: {
                        name: self.name,
                        type: self.type,
                        value: value
                    }
                }, 'property "%s" is of type %s not %s"', self.name,
                    typeof (value), self.type);
            }
        }
        if (self.opts.validate && (value !== undefined || self.required)) {
            self.opts.validate(self, value);
        }
    }

    /**
     * Sets the default value if no other value has been set.
     * @throws {ValueRequiredError} if a value is required and there is no
     * default value.
     */
    validate_default() {
        assert.strictEqual(arguments.length, 0,
            'Invalid signature: MachineProp.validate_default()');
        var self = this;

        if (self.initialized) {
            return;
        }
        if (!self.hasOwnProperty('defval')) {
            if (self.required) {
                throw new VError({
                    name: 'ValueRequiredError',
                    info: self.name
                }, 'property "%s" requires a value', self.name);
            }
            return;
        }
        if (typeof (self.defval) === 'function') {
            self.set(self.defval());
        } else {
            self.set(self.defval);
        }
    }
}

/**
 * @extends MachProp
 * A machine property containing an array of objects.  It is highly recommended
 * that instances use opts.validate to pass as validator to check each object.
 */
class MachPropArrayOfObjects extends MachProp {
    constructor(machine, name, target, opts) {
        assert.strictEqual(arguments.length, 4, 'Invalid signature: ' +
            'MachPropArrayOfObjects(machine, name, target, opts)');

        function validateMachPropArrrayOfObjects(prop, value) {
            try {
                assert.arrayOfObject(value);
            } catch (err) {
                throw new VError({
                    name: 'BadPropertyTypeError',
                    cause: err,
                    info: {
                        prop: prop.name,
                        value: value
                    }
                }, 'property "%s" is not of type ArrayOfObject', prop.name);
            }
        }

        if (!opts.validate) {
            opts.validate = validateMachPropArrrayOfObjects;
        }

        super(machine, name, null, target, opts);
    }

    copy(value) {
        assert.strictEqual(arguments.length, 1, 'Invalid signature: ' +
            'MachPropArrayOfObjects.copy(value)');
        return deepcopy(value);
    }
}

/**
 * @extends MachProp
 * A machine property containing an array of objects.  It is highly recommended
 * that instances use opts.validate to pass as validator to check each string.
 */
class MachPropArrayOfStrings extends MachProp {
    constructor(machine, name, target, opts) {
        assert.strictEqual(arguments.length, 4, 'Invalid signature: ' +
            'MachPropArrayOfStrings(machine, name, target, opts)');

        function validateMachPropArrrayOfStrings(prop, value) {
            try {
                assert.arrayOfString(value);
            } catch (err) {
                throw new VError({
                    name: 'BadPropertyTypeError',
                    cause: err,
                    info: {
                        prop: prop.name,
                        value: value
                    }
                }, 'property "%s" is not of type ArrayOfString', prop.name);
            }
        }

        if (!opts.validate) {
            opts.validate = validateMachPropArrrayOfStrings;
        }

        super(machine, name, 'object', target, opts);
    }

    copy(value) {
        assert.strictEqual(arguments.length, 1, 'Invalid signature: ' +
            'MachPropArrayOfStrings.copy(value)');
        return deepcopy(value);
    }
}

/**
 * @extends MachProp
 * A machine property for boolean values.
 */
class MachPropBool extends MachProp {
    constructor(machine, name, target, opts) {
        assert.strictEqual(arguments.length, 4, 'Invalid signature: ' +
            'MachPropBool(machine, name, target, opts)');
        super(machine, name, 'boolean', target, opts);
    }
}

/**
 * @extends MachProp
 * A machine property for any Object.
 */
class MachPropObject extends MachProp {
    constructor(machine, name, target, opts) {
        assert.strictEqual(arguments.length, 4, 'Invalid signature: ' +
            'MachPropObject(machine, name, target, opts)');
        super(machine, name, 'object', target, opts);
    }

    validate(value) {
        assert.strictEqual(arguments.length, 1, 'Invalid signature: ' +
            'MachPropObject.validate(value)');
        super.validate(value);
        var self = this;

        // "typeof null" evalutes to "object", so super()'s check was inadequte.
        if (value === null) {
            throw new VError({
                name: 'BadPropertyTypeError',
                info: {
                    name: self.name,
                    type: self.type,
                    value: value
                }
            }, 'property "%s" is "null" not an object', self.name);
        }
    }
}

/**
 * @extends MachProp
 * A machine property determined soley by runtime state
 */
class MachPropDynamic extends MachProp {
    /**
     * Create a dynamic property. Unlike other MachProp types, this does not
     * take a target parameter.
     * @param {Machine} machine - The machine to which this property belongs.
     * @param {string} name - The name of the property.
     * @param {Object} opts - Options, as described in the MachProp constructor.
     * @param {function} opts.getter - Required. Generates a value when called.
     * @param {boolean} opts.required - Not allowed in this class.
     * @param {boolean} opts.writable - Not allowed in this class.
     */
    constructor(machine, name, opts) {
        assert.strictEqual(arguments.length, 3,
            'Invalid signature: MachPropDyanmic(machine, name, opts)');
        assert.strictEqual(opts.required, undefined, 'opts.required');
        assert.strictEqual(opts.writable, undefined, 'opts.writable');
        assert.func(opts.getter, 'opts.getter');
        opts.required = false;
        opts.writable = false;
        super(machine, name, null, null, opts);
        this.initialized = true;
    }
}

/**
 * @extends MachProp
 * A machine property for an integer value.
 */
class MachPropInteger extends MachProp {
    /**
     * Create a property to validate and store an integer. See MachProp for most
     * parameters. This constructor also uses:
     * @param {int} opts.min - The minimum value that may be assigned.
     * @param {int} opts.max - The maximum value that may be assigned.
     */
    constructor(machine, name, target, opts) {
        assert.strictEqual(arguments.length, 4, 'Invalid signature: ' +
            'MachPropInteger(machine, name, target, opts)');
        assert.optionalNumber(opts.min, 'opts.min');
        assert.optionalNumber(opts.max, 'opts.max');
        super(machine, name, null, target, opts);
    }

    /**
     * Validate that the value has a legal value.
     * @param {int} value - The value to check.
     * @throws {AssertionError} - Value is out of range or is not an integer.
     */
    validate(value) {
        assert.strictEqual(arguments.length, 1, 'Invalid signature: ' +
            'MachPropInteger.validate(value)');
        super.validate(value);
        var self = this;

        if (value !== parseInt(value, 10)) {
            throw new VError({
                name: 'BadPropertyTypeError',
                info: {
                    name: self.name,
                    value: value
                }
            }, `value of ${self.name} must be an integer`);
        }

        if (self.opts &&
            ((self.opts.hasOwnProperty('min') && value < self.opts.min) ||
            (self.opts.hasOwnProperty('max') && value > self.opts.max))) {

            throw new VError({
                name: 'BadPropertyRangeError',
                info: {
                    name: self.name,
                    value: value,
                    min: self.opts.min,
                    max: self.opts.max
                }
            }, `value ${value} of ${self.name} not in range ` +
                `[${self.opts.min}, ${self.opts.max}]`);
        }

        if (value < Number.MIN_SAFE_INTEGER ||
            value > Number.MAX_SAFE_INTEGER) {

            throw new VError({
                name: 'BadPropertyRangeError',
                info: {
                    value: value,
                    min_safe_integer: Number.MIN_SAFE_INTEGER,
                    max_safe_integer: Number.MAX_SAFE_INTEGER
                }
            }, `value of ${self.name} must be in the safe integer range ` +
                `[${Number.MIN_SAFE_INTEGER}, ${Number.MAX_SAFE_INTEGER}]`);
        }

    }
}

/**
 * @extends MachProp
 * A machine property for an ISO 8601 time stamp of the for
 * YYYY-MM-DDTHH:MM:SSZ.
 */
class MachPropISO8601 extends MachProp {
    constructor(machine, name, target, opts) {
        assert.strictEqual(arguments.length, 4, 'Invalid signature: ' +
            'MachPropISO8601(machine, name, target, opts)');
        super(machine, name, 'string', target, opts);
    }

    validate(value) {
        assert.strictEqual(arguments.length, 1, 'Invalid signature: ' +
            'MachPropString.validate(value)');
        super.validate(value);

        var check = new Date(Date.parse(value));
        check = check.toISOString().split('.')[0] + 'Z';
        assert.strictEqual(value, check,
            this.name + ' must be ISO date string without milliseconds');
    }
}

/**
 * @extends MachProp
 * A machine property for a UUID.
 */
class MachPropUUID extends MachProp {
    constructor(machine, name, target, opts) {
        assert.strictEqual(arguments.length, 4, 'Invalid signature: ' +
            'MachPropUUID(machine, name, target, opts)');
        super(machine, name, 'string', target, opts);
    }

    validate(value) {
        assert.strictEqual(arguments.length, 1, 'Invalid signature: ' +
            'MachPropUUID.validate(value)');
        super.validate(value);
        var self = this;
        var uuid_re = /^([0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;

        if (typeof value !== 'string' || !value.match(uuid_re)) {
            throw new VError({
                name: 'BadPropertyTypeError',
                info: {
                    name: self.name,
                    value: value
                }
            }, `value of ${self.name} must be a UUID (lower-case)`);
        }

    }
}

/**
 * @extends MachProp
 * A machine property for a string.
 */
class MachPropString extends MachProp {
    /**
     * Create a property to validate and store an integer. See MachProp for most
     * parameters. This constructor also uses:
     * @param {int} opts.min - The minimum string length.
     * @param {int} opts.max - The maximum string length.
     * @param {string[]} opts.allowed - Restrict the allowed values of the
     * string to one in this list.
     */
    constructor(machine, name, target, opts) {
        assert.strictEqual(arguments.length, 4, 'Invalid signature: ' +
            'MachPropString(machine, name, target, opts)');
        super(machine, name, 'string', target, opts);
    }

    validate(value) {
        assert.strictEqual(arguments.length, 1, 'Invalid signature: ' +
            'MachPropString.validate(value)');
        super.validate(value);
        var self = this;
        var opts = self.opts;

        if (opts &&
            ((opts.hasOwnProperty('min') && value.length < opts.min) ||
            (opts.hasOwnProperty('max') && value.length > opts.max))) {

            throw new VError({
                name: 'BadPropertyRangeError',
                info: {
                    name: self.name,
                    value: value,
                    min: opts.min,
                    max: opts.max
                }
            }, `length of value "${value}" of ${self.name} is not in range ` +
                `[${opts.min}, ${opts.max}]`);
        }
    }
}

module.exports = {
    // For unit tests, not generally consumed.
    MachProp: MachProp,
    MachPropArrayOfObjects: MachPropArrayOfObjects,
    MachPropArrayOfStrings: MachPropArrayOfStrings,
    MachPropBool: MachPropBool,
    MachPropDynamic: MachPropDynamic,
    MachPropInteger: MachPropInteger,
    MachPropISO8601: MachPropISO8601,
    MachPropObject: MachPropObject,
    MachPropString: MachPropString,
    MachPropUUID: MachPropUUID
};
