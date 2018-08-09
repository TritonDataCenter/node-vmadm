#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2018, Joyent, Inc.
#

#
# node-vmadm Makefile
#


#
# Tools
#

TAP := ./node_modules/.bin/tap


#
# Files
#

JS_FILES := $(shell find lib -name '*.js')
ESLINT_FILES := $(JS_FILES)

include ./tools/mk/Makefile.defs
include ./tools/mk/Makefile.node_modules.defs


#
# Variables
#

NPM = npm
NODE = node
TEST_UNIT_JOBS ?= 4
BUILD = $(TOP)/build
CLEAN_FILES += $(BUILD)


#
# Targets
#
.PHONY: all
all: $(STAMP_NODE_MODULES)

$(TAP): $(STAMP_NODE_MODULES)

$(BUILD):
	mkdir $@

.PHONY: test-unit
test-unit: | $(TAP) $(STAMP_NODE_MODULES) $(BUILD)
	$(TAP) --jobs=$(TEST_UNIT_JOBS) --output-file=$(BUILD)/test.unit.tap test/unit/**/*.test.js

.PHONY: test-coverage-unit
test-coverage-unit: | $(TAP) $(STAMP_NODE_MODULES) $(BUILD)
	$(TAP) --jobs=$(TEST_UNIT_JOBS) --output-file=$(BUILD)/test.unit.tap --coverage \
		test/unit/**/*.test.js


include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.targ
include ./tools/mk/Makefile.node_modules.targ
