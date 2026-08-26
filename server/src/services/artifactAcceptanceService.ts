import type { Db } from "../db/connection.js";
import { conflict, notFound } from "../errors.js";
import {
  getSpecialistArtifact,
  setPendingSpecialistArtifactAcceptance,
  type SpecialistArtifact,
} from "../repos/specialistArtifactRepo.js";

export async function decideArtifactAcceptance(
  db: Db,
  artifactId: string,
  decision: "ACCEPTED" | "REJECTED",
  actor: string,
  note: string | null,
): Promise<SpecialistArtifact> {
  return db.withTransaction(async (tx) => {
    const artifact = await getSpecialistArtifact(tx, artifactId);
    if (!artifact) throw notFound("resource not found");
    if (artifact.acceptanceStatus === decision) return artifact;
    if (artifact.acceptanceStatus !== "PENDING") {
      throw conflict(
        "artifact acceptance decision conflicts with the persisted decision",
        "ARTIFACT_ACCEPTANCE_CONFLICT",
      );
    }
    const decided = await setPendingSpecialistArtifactAcceptance(
      tx,
      artifactId,
      decision,
      actor,
      note,
      new Date().toISOString(),
    );
    if (decided) return decided;
    const concurrent = await getSpecialistArtifact(tx, artifactId);
    if (concurrent?.acceptanceStatus === decision) return concurrent;
    throw conflict(
      "artifact acceptance decision conflicts with the persisted decision",
      "ARTIFACT_ACCEPTANCE_CONFLICT",
    );
  });
}
