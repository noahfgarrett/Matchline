import { LAUNCHER_ERROR_CODES, SERVICE_ERROR_CODES } from './extraction-protocol.js';

/**
 * Everything extraction says to a person, in one table.
 *
 * The rule for every line here (RELEASE-1.0-PLAN, "commissioning language"):
 * say what happened in the words of the job, and name the thing the user can
 * DO next. "EXTRACT_FAILED" is not a sentence; "Navisworks started but the
 * model walk did not finish" is, and "try again, and if it fails the same way
 * send the diagnostic file named below" is the action.
 *
 * The launcher's own message is kept alongside — it carries the specifics (the
 * install folder it looked in, the versions it found, the path of the stream it
 * kept for diagnosis) that a fixed sentence cannot. The plain sentence leads,
 * the launcher's detail follows.
 *
 * A code with no row here still produces a usable line rather than an empty
 * one: an unrecognised code is a launcher newer than this build, which is worth
 * saying honestly instead of hiding.
 */

/** Every failure code, mapped to what happened and what to do about it. */
const FAILURE_COPY: Readonly<Record<string, string>> = {
  /* ------------------------------------------------- from the launcher */

  [LAUNCHER_ERROR_CODES.navisworksNotInstalled]:
    'This machine has no Navisworks that Matchline can drive. Extraction needs a licensed ' +
    'Navisworks Manage or Simulate installed here — Freedom has no API and cannot be used. ' +
    'Extract the model on a machine that has one, or add the extraction cache it produced.',

  [LAUNCHER_ERROR_CODES.navisworksVersionTooNew]:
    'This file was published by a newer Navisworks than the one installed here, and Navisworks ' +
    'files do not open backwards. Republish it from the version installed on this machine, or ' +
    'install the Navisworks that made it and extract again.',

  [LAUNCHER_ERROR_CODES.openFailed]:
    'Navisworks could not open this file. The usual causes are the file being open in ' +
    'Navisworks already, no permission to read it, or — for an NWF — the models it references ' +
    'not being where it expects them. Close it everywhere else, check the referenced files ' +
    'are reachable, and add it again.',

  [LAUNCHER_ERROR_CODES.extractFailed]:
    'Navisworks opened the file but the model walk did not finish, so no cache was written. ' +
    'Nothing was left half-made. Add the file again to retry; if it stops the same way, the ' +
    'launcher kept a diagnostic stream file named in the detail below.',

  [LAUNCHER_ERROR_CODES.cacheWriteFailed]:
    'The model was read but the extraction cache failed its integrity check, so it was thrown ' +
    'away rather than kept. Check there is free disk space, then add the file again.',

  [LAUNCHER_ERROR_CODES.inputNotFound]:
    'The file was gone by the time extraction reached it. Add it again from where it is now.',

  [LAUNCHER_ERROR_CODES.invalidArguments]:
    'Matchline asked the extractor for something it did not understand, which is a fault in ' +
    'Matchline rather than in your model. Report the detail below.',

  [LAUNCHER_ERROR_CODES.internal]:
    'The extractor stopped on an error it did not expect. Add the file again; if it happens ' +
    'twice, report the detail below.',

  [LAUNCHER_ERROR_CODES.cancelled]:
    'Extraction was cancelled. Nothing was written and nothing was left half-made. Add the ' +
    'file again when you want to run it.',

  /* --------------------------------------------------- from Matchline */

  [SERVICE_ERROR_CODES.unavailableOnThisPlatform]:
    'Matchline extracts Navisworks models on Windows, because that is where Navisworks runs. ' +
    'This copy is not on Windows, so the file is registered but not read. Extract it on a ' +
    'Windows machine with Navisworks and add the .matchline-cache it produces here, or open ' +
    'this project there.',

  [SERVICE_ERROR_CODES.extractorNotInstalled]:
    'The Matchline extractor is missing from this installation, so there is nothing to run ' +
    'Navisworks with. Reinstall Matchline, or add an extraction cache produced elsewhere.',

  [SERVICE_ERROR_CODES.extractorStopped]:
    'The extractor stopped before it reported anything. Nothing was written. Add the file ' +
    'again; if it stops the same way, report the detail below.',

  [SERVICE_ERROR_CODES.cacheUnreadable]:
    'Extraction finished but the cache it produced cannot be read by this version of ' +
    'Matchline. Nothing has been added to the project. Add the file again, and if it repeats, ' +
    'report the detail below.',

  [SERVICE_ERROR_CODES.cacheEmpty]:
    'Extraction finished without finding a single object in this model. That is a file with ' +
    'no model data in it rather than a failed run — check you added the right file, or open ' +
    'it in Navisworks to confirm it holds geometry.',

  [SERVICE_ERROR_CODES.cacheMismatch]:
    'The extraction cache says it came from different bytes than the file this project ' +
    'recorded, so it was not associated. Add the file again to extract it fresh.',
};

/**
 * Warning codes worth a sentence of their own on screen 1.
 *
 * Everything else the launcher forwards is shown as-is: a per-property read
 * failure is already legible and there are thousands of possible spellings. The
 * ones here are the ones whose consequence is not obvious from the message.
 */
const WARNING_COPY: Readonly<Record<string, string>> = {
  ADAPTER_UNVERIFIED:
    'This Navisworks version has not been proven against a real install yet. The extraction ' +
    'ran; treat its counts as unconfirmed until that version is verified.',
  ADAPTER_VERSION_UNKNOWN:
    'Matchline could not tell which Navisworks release opened this file, so it cannot say ' +
    'which adapter produced the cache.',
  STALE_CACHE_DISCARDED:
    'An earlier cache for these bytes was there but did not pass its checks, so it was ' +
    'discarded and the model was extracted again.',
  // `WarningCodes.SearchSetUnresolved` in
  // native/navisworks-common/Records/ExtractionRecords.cs. The set is refused
  // for filtering, not merely noted: an unresolved set is not an empty one, and
  // a profile that filters on it cannot compile at all (P0-3, and
  // `AssetCatalogConfigReason.unresolved-selection-set`).
  SEARCH_SET_UNRESOLVED:
    'This saved search would not run, so Navisworks never said which equipment is in it. ' +
    'Matchline will not filter on a set whose contents nobody found out — a profile naming ' +
    'it is refused rather than compiled against an empty answer. Resolve it in Navisworks ' +
    'and extract the model again, or filter on something else.',
  SELECTION_SET_MEMBER_UNRESOLVED:
    'Some Selection Set members did not match anything in the model and were left out of the set.',
  SOURCE_MODEL_READ_FAILED:
    'One of the models appended into this file could not be read; the equipment it holds is ' +
    'not in this extraction.',
};

/** The plain-language line for a failure, with the launcher's own detail after it. */
export function describeExtractionFailure(code: string, detail: string): string {
  const copy =
    FAILURE_COPY[code] ??
    `Extraction stopped with a status this version of Matchline does not recognise (${code}). ` +
      'That usually means the extractor is newer than the app. Reinstall Matchline so the two ' +
      'halves match.';
  const trimmed = detail.trim();
  return trimmed === '' ? copy : `${copy} The extractor reported: ${trimmed}`;
}

/** The plain-language line for a forwarded warning, or the warning's own text. */
export function describeExtractionWarning(code: string, message: string): string {
  const copy = WARNING_COPY[code];
  if (copy === undefined) {
    return message.trim() === '' ? code : message;
  }
  return copy;
}

/** Every failure code this build has copy for. Read by the tests, and by nothing else. */
export function failureCodesWithCopy(): readonly string[] {
  return Object.keys(FAILURE_COPY);
}

/* -------------------------------------------------------------- in progress */

/**
 * What a source row says while its extraction is running.
 *
 * Written as statements about the job rather than as labels, because the row
 * is the only place the user learns that dropping an NWD started anything at
 * all: "waiting for the model in front of it" is a queue, explained, and
 * "Navisworks is open with this file" is what the several silent minutes are.
 *
 * The stage's own detail is deliberately NOT folded in here. It is shown under
 * the progress bar, in its own line, and a row that said the same sentence
 * twice would read as a stutter rather than as more information.
 */
export function describeExtractionProgress(
  status: 'queued' | 'hashing' | 'opening' | 'extracting' | 'finalizing',
  fileName: string,
): string {
  switch (status) {
    case 'queued':
      return (
        `${fileName} is waiting its turn. Matchline extracts one model at a time so Navisworks ` +
        'is never asked to open two at once.'
      );
    case 'hashing':
      return (
        `Reading ${fileName} to see whether it has been extracted before. An unchanged model is ` +
        'reused rather than opened again.'
      );
    case 'opening':
      return `Opening ${fileName} in Navisworks. On a large model this takes a few minutes.`;
    case 'extracting':
      return `Reading the equipment and properties out of ${fileName}.`;
    case 'finalizing':
      return `Finishing the extraction of ${fileName} and checking it is complete.`;
    default:
      return fileName;
  }
}

/** What a source row says once a cache has been associated. */
export function describeExtractionSuccess(
  fileName: string,
  objectCount: number,
  sourceModelCount: number,
  reusedExistingCache: boolean,
): string {
  const objects = `${objectCount.toLocaleString('en-US')} ${objectCount === 1 ? 'object' : 'objects'}`;
  const models = `${String(sourceModelCount)} ${sourceModelCount === 1 ? 'source model' : 'source models'}`;
  const lead = reusedExistingCache
    ? `${fileName} has not changed since it was last extracted, so Matchline reused that ` +
      'extraction instead of opening Navisworks again'
    : `Extracted ${fileName}`;
  return (
    `${lead}: ${objects} across ${models}. ` +
    'It joins the equipment universe every other source is matched against.'
  );
}
