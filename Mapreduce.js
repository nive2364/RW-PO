/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define(['N/record', 'N/search', 'N/log'], function(record, search, log) {

    function getInputData(context) {
        var searchObj = search.create({
            type: 'customrecord_bomrev_update_queue',
            filters: [
                ['custrecord_bomrevq_processed', 'is', 'F']
            ],
            columns: [
                'internalid',
                'custrecord_bomrevq_bomrevision',
                'custrecord_bomrevq_assembly',
                'custrecord_bomrevq_oldcomponent',
                'custrecord_bomrevq_newcomponent'
            ]
        });
        var results = searchObj.run().getRange({start: 0, end: 10});
        log.debug('Queue records found', results.length);
        return searchObj;
    }

    function map(context) {
        var result = JSON.parse(context.value);
        var queueId = result.id;
        var fields = result.values;

        context.write({
            key: queueId,
            value: {
                queueId: queueId,
                bomRevisionId: fields.custrecord_bomrevq_bomrevision.value,
                assemblyId: fields.custrecord_bomrevq_assembly.value,
                oldComponentId: fields.custrecord_bomrevq_oldcomponent.value,
                newComponentId: fields.custrecord_bomrevq_newcomponent.value
            }
        });
    }

    function reduce(context) {
        log.debug('Reduce stage - context.values', context.values);
        var data = JSON.parse(context.values[0]);
        var queueId = data.queueId;
        var bomRevisionId = data.bomRevisionId;
        var assemblyId = data.assemblyId;
        var oldComponentId = data.oldComponentId;
        var newComponentId = data.newComponentId;
        log.debug('Reduce stage - oldComponentId', oldComponentId);
        log.debug('Reduce stage - newComponentId', newComponentId);

        log.debug('Processing queue record', data);

        // Date helpers
        var today = new Date();
        var yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);

        function formatDate(d) {
            var yyyy = d.getFullYear();
            var mm = d.getMonth() + 1;
            var dd = d.getDate();
            if (mm < 10) mm = '0' + mm;
            if (dd < 10) dd = '0' + dd;
            return mm + '/' + dd + '/' + yyyy;
        }

        try {
            // 1. Copy the BOM Revision
            var newRevision = record.copy({
                type: 'bomrevision',
                id: bomRevisionId,
                isDynamic: true
            });

            // Explicitly set the base field to false on the new revision
            newRevision.setValue({
                fieldId: 'custrecord_crc_rn_base_rev',
                value: '2' // Set to 'False' (internal ID 2)
            });

            // Remove old component(s)
            for (var i = newRevision.getLineCount({sublistId: 'component'}) - 1; i >= 0; i--) {
                var compId = newRevision.getSublistValue({sublistId: 'component', fieldId: 'item', line: i});
                if (String(compId) === String(oldComponentId)) {
                    newRevision.removeLine({sublistId: 'component', line: i});
                }
            }
            // Add new component
            newRevision.selectNewLine({sublistId: 'component'});
            newRevision.setCurrentSublistValue({sublistId: 'component', fieldId: 'item', value: newComponentId});
            newRevision.setCurrentSublistValue({sublistId: 'component', fieldId: 'quantity', value: 1});
            newRevision.commitLine({sublistId: 'component'});

            // Set a unique name for the new revision (incrementing .1, .2, etc.)
            var bomId = newRevision.getValue({fieldId: 'billofmaterials'});
            var baseName = newRevision.getValue({fieldId: 'name'});
            var maxSuffix = 0;
            var revisionSearch = search.create({
                type: 'bomrevision',
                filters: [
                    ['billofmaterials', 'anyof', bomId],
                    'AND',
                    ['name', 'startswith', baseName]
                ],
                columns: ['name']
            });
            var results = revisionSearch.run().getRange({start: 0, end: 100});
            for (var j = 0; j < results.length; j++) {
                var name = results[j].getValue('name');
                var match = name.match(/\.(\d+)$/);
                if (match) {
                    var suffix = parseInt(match[1], 10);
                    if (suffix > maxSuffix) maxSuffix = suffix;
                }
            }
            var newSuffix = maxSuffix + 1;
            var newName = baseName + '.' + newSuffix;
            newRevision.setValue({fieldId: 'name', value: newName});
            log.debug('Set new revision name', newName);

            // Set effective start date for new revision to four days ago
            var fourDaysAgo = new Date(today);
            fourDaysAgo.setDate(today.getDate() - 4);
            newRevision.setValue({fieldId: 'effectivestartdate', value: fourDaysAgo});
            newRevision.setValue({fieldId: 'effectiveenddate', value: ''}); // Open-ended
            log.debug('Set effective dates for new revision', {from: fourDaysAgo, to: 'open-ended'});

            // Set effective end date for base BOM revision to five days ago
            var fiveDaysAgo = new Date(today);
            fiveDaysAgo.setDate(today.getDate() - 5);
            record.submitFields({
                type: 'bomrevision',
                id: bomRevisionId,
                values: { effectiveenddate: fiveDaysAgo }
            });
            log.debug('Set effective end date for base BOM revision', fiveDaysAgo);

            // Save the new revision
            var newRevisionId = newRevision.save();
            log.audit('Created new BOM Revision', 'New Revision ID: ' + newRevisionId + ', from Original Revision: ' + bomRevisionId);
            // Mark the queue record as processed
            record.submitFields({
                type: 'customrecord_bomrev_update_queue',
                id: queueId,
                values: {
                    custrecord_bomrevq_processed: true
                }
            });
        } catch (e) {
            log.error('Failed to process BOM Revision update', {queueId: queueId, error: e});
            // Mark as processed even if failed to avoid infinite retries
            record.submitFields({
                type: 'customrecord_bomrev_update_queue',
                id: queueId,
                values: {
                    custrecord_bomrevq_processed: true,
                    custrecord_bomrevq_error: e.toString()
                }
            });
            return;
        }
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce
    };
});