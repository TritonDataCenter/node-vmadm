<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2017, Joyent, Inc.
-->

# node-vmadm

This library provides a node.js wrapper for executing SmartOS's
[vmadm(1M)](https://smartos.org/man/1M/vmadm) tool, and processing
its output.

Note that some of the `vmadm` commands this library helps you call are
experimental. Please refer to the manual page for information on each
command's current stability.

This repository is part of the Joyent Triton project. For contribution
guidelines, issues, and general documentation, visit the main
[Triton](https://github.com/joyent/triton) project page.

# Installation

    npm install vmadm

# API

Many of the functions in this library share the following options:

- `include_dni` (optional, defaults to false), whether or not the targeted VM
  should be affected if it's been marked with `do_not_inventory`
- `log`, a [Bunyan](https://github.com/trentm/node-bunyan.git) Logger object
- `req_id` (optional), a UUID to pass to `vmadm` for identifying this request in
  the output logs
- `uuid`, the target VM's UUID

They are listed below where applicable.

## Lifecycle Management

### create(opts, callback)

Calls `vmadm create` with a payload of `opts`. The callback is invoked as
`callback(err, info)`, where `info` is the output JSON object on a successful
VM creation.

Options:

- `log`
- `req_id`

### delete(opts, callback)

Calls `vmadm create <uuid>`. The callback is invoked as `callback(err)`.

Options:

- `include_dni`
- `log`
- `req_id`
- `uuid`

### kill(opts, callback)

Calls `vmadm kill <uuid>`. The callback is invoked as `callback(err)`.

Options:

- `include_dni`
- `log`
- `signal` (optional), the name of the signal to send (i.e. `"SIGKILL"`)
- `uuid`

### reboot(opts, callback)

Calls `vmadm reboot <uuid>`. The callback is invoked as `callback(err)`.

Options:

- `include_dni`
- `log`
- `req_id`
- `uuid`

### reprovision(opts, callback)

Calls `vmadm reprovision <uuid>`. The callback is invoked as `callback(err)`.

Options:

- `image_uuid`, the new image for the VM to use
- `include_dni`
- `log`
- `req_id`
- `uuid`

### start(opts, callback)

Calls `vmadm start <uuid>`. The callback is invoked as `callback(err)`.

Options:

- `include_dni`
- `log`
- `req_id`
- `uuid`

### stop(opts, callback)

Calls `vmadm stop <uuid>`. The callback is invoked as `callback(err)`.

Options:

- `force` (optional), whether to force the VM to stop
- `timeout` (optional), a number of seconds to wait between sending `SIGTERM`
  and `SIGKILL` when stopping Docker containers
- `include_dni`
- `log`
- `req_id`
- `uuid`

### sysrq(opts, callback)

Calls `vmadm sysrq <uuid>`. The callback is invoked as `callback(err)`.

Options:

- `req`, the request to send, `"screenshot"` or `"nmi"`
- `include_dni`
- `log`
- `req_id`
- `uuid`

### update(opts, callback)

Calls `vmadm update` with a payload of `opts`. The callback is invoked as
`callback(err)`.

Options:

- `include_dni`
- `log`
- `req_id`
- `uuid`

## Fetching information

### exists(opts, callback)

Checks whether or not the VM `uuid` exists. The callback is invoked as
`callback(err, present)`. If the VM is present on the system, `present` will
be `true`. Otherwise, it'll be `false`. If an error occurs while trying to
determine whether the VM exists, then `err` will be an explanatory Error.

Options:

- `include_dni`
- `log`
- `uuid`

### info(opts, callback)

Calls `vmadm info <uuid>`. The callback is invoked as `callback(err, info)`.

Options:

- `types` (optional), an array of strings indicating the kind of information
  to return (i.e., `block`, `chardev`, and more; see the manual page for a
  full listing)
- `include_dni`
- `log`
- `req_id`
- `uuid`

### load(opts, callback)

Calls `vmadm get <uuid>`. The callback is invoked as `callback(err, vm)`.

Options:

- `fields` (optional), the set of fields to return on the object (the default is
  to return all fields)
- `include_dni`
- `log`
- `req_id`
- `uuid`

### lookup(search, opts, callback)

Calls `vmadm lookup -j`. `search` is an object representing how to filter VMs,
such as `{"brand": "kvm"}`. The callback is invoked as `callback(err, vms)`,
where `vms` is an array of VM objects.

Options:

- `fields` (optional), the set of fields to return on each object (the default
  is to return all fields)
- `include_dni`
- `log`
- `req_id`

## Managing Snapshots

### create\_snapshot(opts, callback)

Calls `vmadm create-snapshot <uuid>`. The callback is invoked as
`callback(err)`.

Options:

- `snapshot_name`, the name to assign to the new snapshot
- `include_dni`
- `log`
- `req_id`
- `uuid`

### delete\_snapshot(opts, callback)

Calls `vmadm delete-snapshot <uuid>`. The callback is invoked as
`callback(err)`.

Options:

- `snapshot_name`, the name of the snapshot to delete
- `include_dni`
- `log`
- `req_id`
- `uuid`

### rollback\_snapshot(opts, callback)

Calls `vmadm rollback-snapshot <uuid>`. The callback is invoked as
`callback(err)`.

Options:

- `snapshot_name`, the name of the snapshot to roll the target VM back to
- `include_dni`
- `log`
- `req_id`
- `uuid`

## Development

Describe steps necessary for development here.

    make all

# License

This Source Code Form is subject to the terms of the Mozilla Public License, v.
2.0.  For the full license text see LICENSE, or http://mozilla.org/MPL/2.0/.

Copyright (c) 2017, Joyent, Inc.
