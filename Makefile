#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2020 Joyent, Inc.
#

#
# node-vmadm Makefile
#

SHELL = /bin/bash

#
# Tools
#

TAP := ./node_modules/.bin/tap


#
# Files
#
JS_FILES := $(shell find {lib,test} -name '*.js')
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

.PHONY: test
test: test-coverage-unit

.PHONY: test-unit
test-unit: | $(TAP) $(STAMP_NODE_MODULES) $(BUILD)
	$(TAP) --jobs=$(TEST_UNIT_JOBS) --output-file=$(BUILD)/test.unit.tap test/unit/**/*.test.js

.PHONY: test-coverage-unit
test-coverage-unit: | $(TAP) $(STAMP_NODE_MODULES) $(BUILD)
	$(TAP) --jobs=$(TEST_UNIT_JOBS) --output-file=$(BUILD)/test.unit.tap --coverage \
		test/unit/**/*.test.js

.PHONY: cutarelease
cutarelease:
	[[ -z `git status --short` ]]  # If this fails, the working dir is dirty.
	@which json 2>/dev/null 1>/dev/null && \
	    ver=$(shell json -f package.json version) && \
	    name=$(shell json -f package.json name) && \
	    publishedVer=$(shell npm view -loglevel silent -j $(shell json -f package.json name)@$(shell json -f package.json version) version 2>/dev/null) && \
	    if [[ -n "$$publishedVer" ]]; then \
		echo "error: $$name@$$ver is already published to npm"; \
		exit 1; \
	    fi && \
	    echo "** Are you sure you want to tag and publish $$name@$$ver to npm?" && \
	    echo "** Enter to continue, Ctrl+C to abort." && \
	    read
	ver=$(shell cat package.json | json version) && \
	    date=$(shell date -u "+%Y-%m-%d") && \
	    git tag -a "v$$ver" -m "version $$ver ($$date)" && \
	    git push --tags origin && \
	    npm publish

include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.targ
include ./tools/mk/Makefile.node_modules.targ
