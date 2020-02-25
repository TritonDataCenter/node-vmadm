#! /usr/node/bin/node

const machine = require('./lib/machine');

var payload = {
    uuid: '3bef57e8-4eab-4cca-8f7f-577edbdb666d',
    autoboot: false,
    brand: 'lx',
    image_uuid: '63d6e664-3f1f-11e8-aef6-a3120cf8dd9d',
    nics: [{
        ips: ['192.168.1.120/24'],
        nic_tag: 'external',
	name: 'net0'
    }],
    zpool: 'triton'
};

var opts = {
    log: console
};

var m = new machine.Machine(opts, payload);
m.generate(function (err) {
    console.log('generated: ', err);
});
