# Test-management export boundary

`exportTestManagement` creates deterministic JSON or CSV content from an
accepted `TestDesign` and a `VerificationEvidenceReport` produced by the local
verification router. It is a pure boundary: it does not create files, call a
test-management provider, or perform any external write.

The project profile must explicitly allow the requested format and destination
under `reportingExport`. The exporter supports only `json` and `csv`, even when
the profile allows other report formats. The destination is metadata and a
policy check, not an instruction to perform the write.

Every request also requires:

- `destinationConfirmation` with the selected destination, format, confirmer,
  and timestamp;
- `ownerConfirmation` and `designerConfirmation`, each explicitly confirmed;
- execution evidence containing the verification report's observed
  `exit-code:` and triage entries, with matching trace and immutable revision.

The execution state and classification are copied from the execution artifact;
the exporter never infers a pass, failure, or result from the test design.
Missing, design-only, stale, or incomplete execution evidence is rejected.

```ts
const result = exportTestManagement({
  profile,
  design,
  executionEvidence: verificationReport,
  destinationConfirmation: {
    destination: 'local-file',
    format: 'json',
    confirmed: true,
    confirmedBy: 'sdet-owner',
    confirmedAt: '2026-10-15T12:03:00.000Z',
  },
  ownerConfirmation: {
    confirmed: true,
    confirmedBy: 'product-owner',
    confirmedAt: '2026-10-15T12:01:00.000Z',
  },
  designerConfirmation: {
    confirmed: true,
    confirmedBy: 'test-designer',
    confirmedAt: '2026-10-15T12:02:00.000Z',
  },
});

// result.content is the only generated output. A caller may persist it after
// its own separately authorized destination write.
```
