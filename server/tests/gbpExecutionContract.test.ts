import { describe, expect, it } from "vitest";
import {
  GbpExecutionCommandSchema,
  GbpExecutionReceiptSchema,
  GbpReadbackSchema,
  GbpSafeErrorCodeSchema,
  canonicalGbpCommand,
  canonicalGbpCommandBody,
  canonicalGbpCommandCta,
  canonicalGbpCommandImage,
  hashGbpCommand,
  hashGbpCommandBody,
  hashGbpCommandCta,
  hashGbpCommandImage,
} from "../src/domain/gbpExecutionContract.js";

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;

const validCommand = {
  schema_version: "seo_ops.gbp_execution_command.v1",
  instruction_id: "11111111-1111-4111-8111-111111111111",
  task: {
    id: "22222222-2222-4222-8222-222222222222",
    merchant_id: "33333333-3333-4333-8333-333333333333",
    location_id: "44444444-4444-4444-8444-444444444444",
    task_revision: 7,
    execution_spec_sha256: sha("a"),
    approval_decision_id: "55555555-5555-4555-8555-555555555555",
  },
  core: {
    api_user_id: "66666666-6666-4666-8666-666666666666",
    api_user_external_id: "merchant-api-user-9",
    write_secret_ref: "george-gbp-write",
    readback_secret_ref: "george-gbp-readback",
    write_agent_id: "77777777-7777-4777-8777-777777777777",
    write_agent_published_ref: "published:gbp-write:v1",
    readback_agent_id: "88888888-8888-4888-8888-888888888888",
    readback_agent_published_ref: "published:gbp-readback:v1",
  },
  gbp: {
    account_resource: "accounts/123456789",
    location_resource: "locations/987654321",
    timezone: "America/New_York",
    scheduled_for_local: "2026-08-27T08:30:00-04:00",
  },
  operation: { kind: "CREATE_POST" },
  draft: {
    id: "99999999-9999-4999-8999-999999999999",
    version: 3,
    sha256: sha("b"),
    body: "Fresh lunch specials are ready.",
    cta: { type: "ORDER", url: "https://example.test/order" },
    image: {
      deliverable_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sha256: sha("c"),
      alt_text: "Lunch special with rice and vegetables",
    },
  },
  scheduled_for: "2026-08-27T12:30:00.000Z",
  provider_idempotency_key: "gbp-create-11111111-rev7",
  probe_ref: "gbp-probe-11111111-rev7",
} as const;

const validReceipt = {
  schema_version: "seo_ops.gbp_execution_receipt.v1",
  instruction_id: validCommand.instruction_id,
  command_sha256: sha("d"),
  provider_idempotency_key: validCommand.provider_idempotency_key,
  probe_ref: validCommand.probe_ref,
  operation: { kind: "CREATE_POST" },
  core_api_user_id: validCommand.core.api_user_id,
  account_resource: validCommand.gbp.account_resource,
  location_resource: validCommand.gbp.location_resource,
  status: "APPLIED",
  provider_mutation_count: 1,
  provider_post_resource: "accounts/123456789/locations/987654321/localPosts/post-1",
  provider_request_id: "provider-request-1",
  applied_at: "2026-08-27T12:30:04.000Z",
  submitted: {
    body_sha256: sha("e"),
    cta_sha256: sha("f"),
    media_sha256: validCommand.draft.image.sha256,
  },
} as const;

describe("GBP execution contracts", () => {
  it("accepts only an exact CREATE_POST command", () => {
    expect(GbpExecutionCommandSchema.parse(validCommand)).toEqual(validCommand);
    expect(() => GbpExecutionCommandSchema.parse({
      ...validCommand,
      operation: { kind: "UPDATE_POST" },
    })).toThrow();
    expect(() => GbpExecutionCommandSchema.parse({ ...validCommand, raw_token: "never-store-this" })).toThrow();
  });

  it("canonicalizes parsed commands and hashes UTF-8 bytes deterministically", () => {
    const reordered = {
      ...structuredClone(validCommand),
      task: {
        approval_decision_id: validCommand.task.approval_decision_id,
        execution_spec_sha256: validCommand.task.execution_spec_sha256,
        task_revision: validCommand.task.task_revision,
        location_id: validCommand.task.location_id,
        merchant_id: validCommand.task.merchant_id,
        id: validCommand.task.id,
      },
    };
    expect(hashGbpCommand(validCommand)).toBe(hashGbpCommand(reordered));
    expect(canonicalGbpCommand(validCommand)).toBe(canonicalGbpCommand(reordered));
    expect(hashGbpCommand(validCommand)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => canonicalGbpCommand({ ...validCommand, unexpected: true })).toThrow();
  });

  it("accepts only short logical secret names and typed safe error codes", () => {
    for (const rejected of [
      "coreai_token",
      "Bearer-secret",
      "../merchant-secret",
      "merchant secret",
      "a".repeat(64),
    ]) {
      expect(() => GbpExecutionCommandSchema.parse({
        ...validCommand,
        core: { ...validCommand.core, write_secret_ref: rejected },
      })).toThrow();
    }
    expect(GbpSafeErrorCodeSchema.parse("TASK_DRIFT")).toBe("TASK_DRIFT");
    expect(() => GbpSafeErrorCodeSchema.parse("token=secret-value")).toThrow();
  });

  it("requires canonical UTC Z scheduling and an equal local instant with the IANA offset", () => {
    expect(() => GbpExecutionCommandSchema.parse({
      ...validCommand,
      scheduled_for: "2026-08-27T12:30:00.000+00:00",
    })).toThrow();
    expect(() => GbpExecutionCommandSchema.parse({
      ...validCommand,
      gbp: { ...validCommand.gbp, scheduled_for_local: "2026-08-27T12:30:00.000Z" },
    })).toThrow();
    expect(() => GbpExecutionCommandSchema.parse({
      ...validCommand,
      gbp: { ...validCommand.gbp, scheduled_for_local: "2026-08-27T09:30:00-04:00" },
    })).toThrow();
    expect(() => GbpExecutionCommandSchema.parse({
      ...validCommand,
      gbp: { ...validCommand.gbp, scheduled_for_local: "2026-08-27T12:30:00+00:00" },
    })).toThrow();
  });

  it("derives canonical body, CTA, and image hashes only from a parsed command", () => {
    expect(canonicalGbpCommandBody(validCommand)).toBe(
      '{"body":"Fresh lunch specials are ready."}',
    );
    expect(canonicalGbpCommandCta(validCommand)).toBe(
      '{"type":"ORDER","url":"https://example.test/order"}',
    );
    expect(canonicalGbpCommandImage(validCommand)).toBe(
      `{"alt_text":"Lunch special with rice and vegetables","deliverable_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","sha256":"${sha("c")}"}`,
    );
    for (const digest of [
      hashGbpCommandBody(validCommand),
      hashGbpCommandCta(validCommand),
      hashGbpCommandImage(validCommand),
    ]) expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => hashGbpCommandBody({ ...validCommand, leaked: "input" })).toThrow();
  });

  it("keeps receipts strict and enforces the mutation/status invariant", () => {
    expect(GbpExecutionReceiptSchema.parse(validReceipt)).toEqual(validReceipt);
    expect(() => GbpExecutionReceiptSchema.parse({
      ...validReceipt,
      provider_mutation_count: 2,
    })).toThrow();
    expect(() => GbpExecutionReceiptSchema.parse({ ...validReceipt, extra: true })).toThrow();
    expect(() => GbpExecutionReceiptSchema.parse({
      ...validReceipt,
      status: "APPLIED",
      provider_mutation_count: 0,
    })).toThrow();
    expect(() => GbpExecutionReceiptSchema.parse({
      ...validReceipt,
      status: "ALREADY_APPLIED",
      provider_mutation_count: 1,
    })).toThrow();
    expect(() => GbpExecutionReceiptSchema.parse({
      ...validReceipt,
      status: "REJECTED_PRE_MUTATION",
      provider_mutation_count: 0,
    })).toThrow();
    expect(GbpExecutionReceiptSchema.parse({
      ...validReceipt,
      status: "REJECTED_PRE_MUTATION",
      provider_mutation_count: 0,
      provider_post_resource: null,
      applied_at: null,
    })).toMatchObject({ status: "REJECTED_PRE_MUTATION" });
  });

  it("keeps independent readback observations strict", () => {
    const readback = {
      schema_version: "seo_ops.gbp_readback.v1",
      instruction_id: validCommand.instruction_id,
      command_sha256: sha("d"),
      core_run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      readback_agent_id: validCommand.core.readback_agent_id,
      account_resource: validCommand.gbp.account_resource,
      location_resource: validCommand.gbp.location_resource,
      provider_post_resource: validReceipt.provider_post_resource,
      observed_at: "2026-08-27T12:31:00.000Z",
      body: validCommand.draft.body,
      cta: validCommand.draft.cta,
      media: [{
        provider_media_resource: "media/customer-photo-1",
        sha256: validCommand.draft.image.sha256,
      }],
    };
    expect(GbpReadbackSchema.parse(readback)).toEqual(readback);
    expect(() => GbpReadbackSchema.parse({ ...readback, semantic_similarity: 1 })).toThrow();
  });
});
