#! /usr/node/bin/node

const machine = require('./lib/machine');
const vasync = require('vasync');

var payload = {
    uuid: '6faaa5a7-5459-4029-ab7e-f8f0b5252410',
    autoboot: false,
    brand: 'lx',
    image_uuid: '63d6e664-3f1f-11e8-aef6-a3120cf8dd9d',
    nics: [{
        ips: ['192.168.1.121/24'],
        nic_tag: 'external',
	name: 'net0'
    }],
    zpool: 'triton'
};

var opts = {
    log: console
};

var m = new machine.Machine(opts, payload.uuid);
m.setAllProps({}, payload);
vasync.waterfall([
    function install(next) {
        m.install({}, next);
    },
    function load(next) {
        m.load({}, function (err, cfg) {
            if (err) {
                next(err);
                return;
            }
            console.log('Installed', cfg);
            next();
        });
    }
], function done(err) {
    if (err) {
        console.log('Error:', err);
    }
});
