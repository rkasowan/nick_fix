(function process(/*RESTAPIRequest*/ request, body) {
    var VERSION = '2026-04-16a';
    var LOOKUP_TABLE = 'cmdb_ci_hardware';
    var MAX_QUERY_ROWS = 50;
    var WRAPPER_KEYS = {
        event: true,
        payload: true,
        data: true,
        record: true,
        alert: true
    };
    var NODE_ALIASES = [
        'node',
        'host',
        'host_name',
        'hostname',
        'server',
        'device',
        'fqdn',
        'name'
    ];
    var FIELD_CACHE = {};

    function isObject(value) {
        return Object.prototype.toString.call(value) === '[object Object]';
    }

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    function hasOwn(obj, key) {
        return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
    }

    function hasValue(value) {
        return value !== null && typeof value !== 'undefined' && String(value).replace(/^\s+|\s+$/g, '') !== '';
    }

    function trimToString(value) {
        return String(value).replace(/^\s+|\s+$/g, '');
    }

    function lower(value) {
        return trimToString(value).toLowerCase();
    }

    function compactAlphaNum(value) {
        return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function tokenize(value) {
        var tokens = String(value || '').toLowerCase().match(/[a-z0-9]+/g);
        return tokens ? tokens : [];
    }

    function looksLikeSysId(value) {
        return /^[0-9a-fA-F]{32}$/.test(trimToString(value));
    }

    function looksLikeIPv4(value) {
        return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimToString(value));
    }

    function safeJSONStringify(value) {
        try {
            return JSON.stringify(value, null, 2);
        } catch (e) {
            return String(value);
        }
    }

    function shallowCloneWithout(source, keyToOmit) {
        var out = {};
        var key;
        if (!isObject(source)) {
            return out;
        }
        for (key in source) {
            if (hasOwn(source, key) && key !== keyToOmit) {
                out[key] = source[key];
            }
        }
        return out;
    }

    function uniquePush(list, value) {
        var i;
        for (i = 0; i < list.length; i++) {
            if (list[i] === value) {
                return;
            }
        }
        list.push(value);
    }

    function getFirstPresent(obj, aliases) {
        var i;
        if (!isObject(obj)) {
            return '';
        }
        for (i = 0; i < aliases.length; i++) {
            if (hasOwn(obj, aliases[i]) && hasValue(obj[aliases[i]])) {
                return trimToString(obj[aliases[i]]);
            }
        }
        return '';
    }

    function extractNode(record, envelope) {
        var key;
        var nodeValue = getFirstPresent(record, NODE_ALIASES);
        if (hasValue(nodeValue)) {
            return nodeValue;
        }

        if (isObject(record)) {
            for (key in WRAPPER_KEYS) {
                if (hasOwn(WRAPPER_KEYS, key) && isObject(record[key])) {
                    nodeValue = getFirstPresent(record[key], NODE_ALIASES);
                    if (hasValue(nodeValue)) {
                        return nodeValue;
                    }
                }
            }
        }

        nodeValue = getFirstPresent(envelope, NODE_ALIASES);
        if (hasValue(nodeValue)) {
            return nodeValue;
        }

        if (isObject(envelope)) {
            for (key in WRAPPER_KEYS) {
                if (hasOwn(WRAPPER_KEYS, key) && isObject(envelope[key])) {
                    nodeValue = getFirstPresent(envelope[key], NODE_ALIASES);
                    if (hasValue(nodeValue)) {
                        return nodeValue;
                    }
                }
            }
        }

        return '';
    }

    function tableHasField(tableName, fieldName) {
        var cacheKey = tableName + '.' + fieldName;
        var gr;
        if (hasOwn(FIELD_CACHE, cacheKey)) {
            return FIELD_CACHE[cacheKey];
        }
        gr = new GlideRecord(tableName);
        FIELD_CACHE[cacheKey] = gr.isValidField(fieldName);
        return FIELD_CACHE[cacheKey];
    }

    function readField(gr, fieldName) {
        if (!hasValue(fieldName) || !gr || !gr.isValidField(fieldName)) {
            return '';
        }
        return hasValue(gr.getValue(fieldName)) ? String(gr.getValue(fieldName)) : '';
    }

    function readDisplayField(gr, fieldName) {
        if (!hasValue(fieldName) || !gr || !gr.isValidField(fieldName)) {
            return '';
        }
        return hasValue(gr.getDisplayValue(fieldName)) ? String(gr.getDisplayValue(fieldName)) : '';
    }

    function summarizeCandidate(gr) {
        var tableName = hasValue(readField(gr, 'sys_class_name')) ? readField(gr, 'sys_class_name') : LOOKUP_TABLE;
        return {
            sys_id: String(gr.getUniqueValue()),
            table: tableName,
            name: readField(gr, 'name'),
            fqdn: readField(gr, 'fqdn'),
            sys_class_name: readField(gr, 'sys_class_name'),
            install_status: readField(gr, 'install_status'),
            install_status_display: readDisplayField(gr, 'install_status'),
            operational_status: readField(gr, 'operational_status'),
            operational_status_display: readDisplayField(gr, 'operational_status'),
            duplicate_of: readField(gr, 'duplicate_of')
        };
    }

    function buildLookupContext(nodeValue) {
        var rawValue = trimToString(nodeValue);
        var shortName = rawValue;
        if (rawValue.indexOf('.') >= 0 && !looksLikeIPv4(rawValue)) {
            shortName = rawValue.split('.')[0];
        }
        return {
            raw: rawValue,
            lower: lower(nodeValue),
            compact: compactAlphaNum(nodeValue),
            short_name: shortName,
            short_lower: lower(shortName),
            short_compact: compactAlphaNum(shortName),
            tokens: tokenize(nodeValue),
            short_tokens: tokenize(shortName)
        };
    }

    function countOverlap(left, right) {
        var seen = {};
        var count = 0;
        var i;
        if (!isArray(left) || !isArray(right)) {
            return 0;
        }
        for (i = 0; i < left.length; i++) {
            seen[left[i]] = true;
        }
        for (i = 0; i < right.length; i++) {
            if (seen[right[i]]) {
                count += 1;
                delete seen[right[i]];
            }
        }
        return count;
    }

    function scoreCandidate(candidate, ctx, stageBaseScore) {
        var score = stageBaseScore || 0;
        var nameLower = lower(candidate.name);
        var fqdnLower = lower(candidate.fqdn);
        var nameCompact = compactAlphaNum(candidate.name);
        var fqdnCompact = compactAlphaNum(candidate.fqdn);
        var nameTokens = tokenize(candidate.name);
        var fqdnTokens = tokenize(candidate.fqdn);
        var installDisplay = lower(candidate.install_status_display);
        var opDisplay = lower(candidate.operational_status_display);
        var overlap = 0;

        if (nameLower === ctx.lower) {
            score += 90;
        }
        if (fqdnLower === ctx.lower) {
            score += 100;
        }
        if (hasValue(ctx.short_lower) && nameLower === ctx.short_lower) {
            score += 85;
        }
        if (hasValue(ctx.short_lower) && fqdnLower === ctx.short_lower) {
            score += 70;
        }

        if (ctx.compact && nameCompact === ctx.compact) {
            score += 60;
        }
        if (ctx.compact && fqdnCompact === ctx.compact) {
            score += 65;
        }
        if (ctx.short_compact && nameCompact === ctx.short_compact) {
            score += 55;
        }
        if (ctx.short_compact && fqdnCompact === ctx.short_compact) {
            score += 45;
        }

        if (ctx.lower && nameLower.indexOf(ctx.lower) === 0) {
            score += 35;
        }
        if (ctx.lower && fqdnLower.indexOf(ctx.lower) === 0) {
            score += 40;
        }
        if (ctx.short_lower && nameLower.indexOf(ctx.short_lower) === 0) {
            score += 30;
        }
        if (ctx.short_lower && fqdnLower.indexOf(ctx.short_lower) === 0) {
            score += 32;
        }

        if (ctx.lower && nameLower.indexOf(ctx.lower) >= 0) {
            score += 20;
        }
        if (ctx.lower && fqdnLower.indexOf(ctx.lower) >= 0) {
            score += 24;
        }
        if (ctx.short_lower && nameLower.indexOf(ctx.short_lower) >= 0) {
            score += 18;
        }
        if (ctx.short_lower && fqdnLower.indexOf(ctx.short_lower) >= 0) {
            score += 20;
        }

        overlap = countOverlap(ctx.tokens, nameTokens) + countOverlap(ctx.short_tokens, nameTokens);
        score += overlap * 6;
        overlap = countOverlap(ctx.tokens, fqdnTokens) + countOverlap(ctx.short_tokens, fqdnTokens);
        score += overlap * 7;

        if (candidate.duplicate_of) {
            score -= 10;
        }
        if (installDisplay.indexOf('installed') >= 0 || installDisplay.indexOf('in use') >= 0 || installDisplay.indexOf('production') >= 0) {
            score += 5;
        }
        if (installDisplay.indexOf('retired') >= 0 || installDisplay.indexOf('absent') >= 0) {
            score -= 8;
        }
        if (opDisplay.indexOf('operational') >= 0 || opDisplay.indexOf('up') >= 0 || opDisplay.indexOf('online') >= 0) {
            score += 5;
        }
        if (opDisplay.indexOf('down') >= 0 || opDisplay.indexOf('non-operational') >= 0) {
            score -= 4;
        }

        return score;
    }

    function addCandidate(store, gr, method, ctx, stageBaseScore) {
        var candidate = summarizeCandidate(gr);
        var existing = store.by_sys_id[candidate.sys_id];
        candidate.score = scoreCandidate(candidate, ctx, stageBaseScore);
        candidate.methods = [method];
        candidate.best_method = method;

        if (!existing) {
            store.by_sys_id[candidate.sys_id] = candidate;
            store.list.push(candidate);
            return;
        }

        uniquePush(existing.methods, method);
        if (candidate.score > existing.score) {
            existing.score = candidate.score;
            existing.best_method = method;
        }
    }

    function queryExactByField(store, fieldName, value, method, ctx, debug) {
        var gr;
        if (!hasValue(fieldName) || !hasValue(value) || !tableHasField(LOOKUP_TABLE, fieldName)) {
            return;
        }
        debug.exact_methods.push(method + '=' + trimToString(value));
        gr = new GlideRecord(LOOKUP_TABLE);
        gr.addQuery(fieldName, trimToString(value));
        gr.setLimit(MAX_QUERY_ROWS);
        gr.query();
        while (gr.next()) {
            addCandidate(store, gr, method, ctx, 200);
        }
    }

    function queryFuzzyByField(store, fieldName, value, method, ctx, debug) {
        var gr;
        if (!hasValue(fieldName) || !hasValue(value) || !tableHasField(LOOKUP_TABLE, fieldName)) {
            return;
        }
        debug.fuzzy_methods.push(method + '=' + trimToString(value));
        gr = new GlideRecord(LOOKUP_TABLE);
        gr.addQuery(fieldName, 'CONTAINS', trimToString(value));
        gr.setLimit(MAX_QUERY_ROWS);
        gr.query();
        while (gr.next()) {
            addCandidate(store, gr, method, ctx, 100);
        }
    }

    function runLookup(nodeValue) {
        var ctx = buildLookupContext(nodeValue);
        var debug = {
            exact_methods: [],
            fuzzy_methods: []
        };
        var store = {
            by_sys_id: {},
            list: []
        };
        var baseGr;
        var exactSelection;
        var finalSelection;

        if (looksLikeSysId(ctx.raw)) {
            debug.exact_methods.push('sys_id=' + ctx.raw);
            baseGr = new GlideRecord(LOOKUP_TABLE);
            if (baseGr.get(ctx.raw)) {
                addCandidate(store, baseGr, 'sys_id_exact', ctx, 240);
            }
        }

        queryExactByField(store, 'name', ctx.raw, 'name_exact', ctx, debug);
        queryExactByField(store, 'fqdn', ctx.raw, 'fqdn_exact', ctx, debug);
        if (ctx.short_name !== ctx.raw) {
            queryExactByField(store, 'name', ctx.short_name, 'short_name_exact', ctx, debug);
        }

        exactSelection = selectBestCandidate(store.list);
        if (exactSelection.match && exactSelection.match.score >= 240) {
            exactSelection.debug = debug;
            return exactSelection;
        }

        queryFuzzyByField(store, 'name', ctx.raw, 'name_contains', ctx, debug);
        if (ctx.short_name !== ctx.raw) {
            queryFuzzyByField(store, 'name', ctx.short_name, 'short_name_contains', ctx, debug);
        }
        queryFuzzyByField(store, 'fqdn', ctx.raw, 'fqdn_contains', ctx, debug);
        if (ctx.short_name !== ctx.raw) {
            queryFuzzyByField(store, 'fqdn', ctx.short_name, 'short_fqdn_contains', ctx, debug);
        }

        finalSelection = selectBestCandidate(store.list);
        finalSelection.debug = debug;
        return finalSelection;
    }

    function sortCandidates(candidates) {
        candidates.sort(function (left, right) {
            if (left.score !== right.score) {
                return right.score - left.score;
            }
            if (left.name !== right.name) {
                return left.name < right.name ? -1 : 1;
            }
            if (left.sys_id === right.sys_id) {
                return 0;
            }
            return left.sys_id < right.sys_id ? -1 : 1;
        });
    }

    function selectBestCandidate(candidates) {
        var ranked = [];
        var selection = {
            match: null,
            ambiguous: false,
            candidates: []
        };
        var first;
        var second;
        var i;

        for (i = 0; i < candidates.length; i++) {
            ranked.push(candidates[i]);
        }
        sortCandidates(ranked);
        selection.candidates = ranked;

        if (ranked.length === 0) {
            return selection;
        }

        first = ranked[0];
        second = ranked.length > 1 ? ranked[1] : null;

        if (!second || first.score > second.score) {
            selection.match = first;
            return selection;
        }

        selection.ambiguous = true;
        return selection;
    }

    function fetchFullRecord(candidate) {
        var tableName = hasValue(candidate.table) ? candidate.table : LOOKUP_TABLE;
        var gr = new GlideRecord(tableName);
        if (gr.get(candidate.sys_id)) {
            return gr;
        }
        gr = new GlideRecord(LOOKUP_TABLE);
        if (gr.get(candidate.sys_id)) {
            return gr;
        }
        return null;
    }

    function serializeRecord(gr) {
        var fields = gr.getFields();
        var values = {};
        var displayValues = {};
        var i;
        var fieldName;
        var rawValue;
        var displayValue;

        for (i = 0; i < fields.size(); i++) {
            fieldName = String(fields.get(i).getName());
            rawValue = gr.getValue(fieldName);
            displayValue = gr.getDisplayValue(fieldName);

            values[fieldName] = rawValue === null || typeof rawValue === 'undefined' ? null : String(rawValue);
            if (displayValue !== null && typeof displayValue !== 'undefined' && String(displayValue) !== String(rawValue)) {
                displayValues[fieldName] = String(displayValue);
            }
        }

        return {
            table: gr.getTableName(),
            sys_id: String(gr.getUniqueValue()),
            record: values,
            display_values: displayValues,
            fqdn: hasValue(values.fqdn) ? values.fqdn : ''
        };
    }

    function summarizeCandidates(candidates) {
        var out = [];
        var i;
        var limit = candidates.length < 10 ? candidates.length : 10;
        var candidate;

        for (i = 0; i < limit; i++) {
            candidate = candidates[i];
            out.push({
                sys_id: candidate.sys_id,
                table: candidate.table,
                name: candidate.name,
                fqdn: candidate.fqdn,
                score: String(candidate.score),
                best_method: candidate.best_method,
                methods: candidate.methods
            });
        }

        return out;
    }

    function buildRecordResult(record, envelope) {
        var nodeValue = extractNode(record, envelope);
        var selection;
        var fullGr;
        var serialized;

        if (!hasValue(nodeValue)) {
            return {
                status: 'error',
                lookup_status: 'missing_node',
                message: 'No node-like field found in the payload.'
            };
        }

        selection = runLookup(nodeValue);

        if (selection.match) {
            fullGr = fetchFullRecord(selection.match);
            if (fullGr) {
                serialized = serializeRecord(fullGr);
                return {
                    status: 'success',
                    lookup_status: 'matched',
                    lookup_method: selection.match.best_method,
                    node_input: nodeValue,
                    fqdn: serialized.fqdn,
                    table: serialized.table,
                    sys_id: serialized.sys_id,
                    record: serialized.record,
                    display_values: serialized.display_values,
                    candidates: summarizeCandidates(selection.candidates),
                    debug: selection.debug
                };
            }
        }

        return {
            status: selection.ambiguous ? 'ambiguous' : 'not_found',
            lookup_status: selection.ambiguous ? 'ambiguous' : 'not_found',
            node_input: nodeValue,
            message: selection.ambiguous ? 'Multiple candidates tied for best match.' : 'No hardware CI matched the supplied node.',
            candidates: summarizeCandidates(selection.candidates),
            debug: selection.debug
        };
    }

    try {
        var payload = typeof body === 'string' ? JSON.parse(body) : body;
        var envelope = {};
        var records = [];
        var results = [];
        var i;
        var response;

        if (isArray(payload)) {
            records = payload;
        } else if (isObject(payload) && isArray(payload.records)) {
            envelope = shallowCloneWithout(payload, 'records');
            records = payload.records;
        } else if (isObject(payload) && isArray(payload.events)) {
            envelope = shallowCloneWithout(payload, 'events');
            records = payload.events;
        } else {
            records = [payload];
        }

        for (i = 0; i < records.length; i++) {
            results.push(buildRecordResult(records[i], envelope));
        }

        response = {
            status: 'success',
            processed: String(results.length),
            lookup_table: LOOKUP_TABLE,
            version: VERSION,
            results: results
        };

        if (results.length === 1) {
            response.status = results[0].status;
            response.result = results[0];
            response.lookup_status = results[0].lookup_status;
            response.node_input = results[0].node_input || '';
            response.fqdn = results[0].fqdn || '';
            response.table = results[0].table || '';
            response.sys_id = results[0].sys_id || '';
            response.record = results[0].record || null;
            response.display_values = results[0].display_values || {};
            response.candidates = results[0].candidates || [];
        }

        return JSON.stringify(response);
    } catch (er) {
        gs.error('nickFixCmdbLookup failed: ' + er);
        if (typeof status !== 'undefined') {
            status = 500;
        }
        return safeJSONStringify({
            status: 'error',
            message: String(er),
            lookup_table: LOOKUP_TABLE,
            version: VERSION
        });
    }
})(request, body);
