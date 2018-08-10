/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */
'use strict';

const os = require('os');

module.exports = {
    platformDefault: function platformDefault() {
        const platform = os.platform();
        // TODO: Can this be made more truthful? vmadm is a SmartOS interface,
        // not illumos wide.
        if (platform === 'sunos') {
            return require('./index.sunos');
        } else {
            throw new Error('no suitable vmadm found for platform: ' +
                            platform);
        }
    },
    SmartOsVmadm: require('./index.sunos'),
    DummyVmadm: require('./dummy')
};
