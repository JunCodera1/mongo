import {
    everyWinningPlan,
    getNestedProperties,
    isIdhackOrExpress
} from "jstests/libs/analyze_plan.js";
import {
    getCollectionName,
    getCommandName,
    getExplainCommand,
    getInnerCommand,
    isInternalDbName,
    isSystemCollectionName
} from "jstests/libs/cmd_object_utils.js";
import {OverrideHelpers} from "jstests/libs/override_methods/override_helpers.js";
import {QuerySettingsIndexHintsTests} from "jstests/libs/query_settings_index_hints_tests.js";
import {QuerySettingsUtils} from "jstests/libs/query_settings_utils.js";

/**
 * Override which applies 'bad' query settings over supported commands in order to test the fallback
 * mechanism. Asserts that the query plans generated by the fallback should be identical to those
 * generated without any query settings.
 */
function runCommandOverride(conn, dbName, _cmdName, cmdObj, clientFunction, makeFuncArgs) {
    const assertFallbackPlanMatchesOriginalPlan = () => {
        if (isInternalDbName(dbName)) {
            // Query settings cannot be set over internal databases.
            return;
        }

        const db = conn.getDB(dbName);
        const innerCmd = getInnerCommand(cmdObj);
        if (!QuerySettingsUtils.isSupportedCommand(getCommandName(innerCmd))) {
            return;
        }

        const explain = db.runCommand(getExplainCommand(innerCmd));
        if (!explain.ok) {
            // Some commands such as $collStats cannot be explained and will lead to failures.
            return;
        }

        // If the query explain has no 'winningPlan', we can not assert for query settings
        // fallback.
        if (getNestedProperties(explain, "winningPlan").length === 0) {
            return;
        }

        const isIdHackQuery =
            everyWinningPlan(explain, (winningPlan) => isIdhackOrExpress(db, winningPlan));
        if (isIdHackQuery) {
            // Query settings cannot be applied over IDHACK or Express queries.
            return;
        }

        const collectionName = getCollectionName(db, innerCmd);
        if (!collectionName || isSystemCollectionName(collectionName)) {
            // Can't test the fallback on queries not involving any collections or queries targeting
            // the system collection:
            // - Queries not involving any collections will always yield to EOF plans.
            // - Query settings validate against queries targeting system collections.
            return;
        }

        const ns = {db: dbName, coll: collectionName};
        const qsutils = new QuerySettingsUtils(db, collectionName);
        const qstests = new QuerySettingsIndexHintsTests(qsutils);
        const representativeQuery = qsutils.makeQueryInstance(innerCmd);
        qstests.assertQuerySettingsFallback(representativeQuery, ns);
    };

    const res = clientFunction.apply(conn, makeFuncArgs(cmdObj));
    if (res.ok) {
        // Only run the test if the original command works. Some tests assert on commands failing,
        // so we should simply bubble these commands through without any additional checks.
        OverrideHelpers.withPreOverrideRunCommand(assertFallbackPlanMatchesOriginalPlan);
    }
    return res;
}

// Override the default runCommand with our custom version.
OverrideHelpers.overrideRunCommand(runCommandOverride);

// Always apply the override if a test spawns a parallel shell.
OverrideHelpers.prependOverrideInParallelShell(
    "jstests/libs/override_methods/implicit_query_settings_fallback.js");
