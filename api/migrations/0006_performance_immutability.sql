CREATE TRIGGER trg_metric_observations_no_update
BEFORE UPDATE ON metric_observations
BEGIN
  SELECT RAISE(ABORT, 'metric_observation_immutable');
END;

CREATE TRIGGER trg_metric_observations_no_delete
BEFORE DELETE ON metric_observations
BEGIN
  SELECT RAISE(ABORT, 'metric_observation_immutable');
END;

CREATE TRIGGER trg_metric_source_artifacts_no_update
BEFORE UPDATE ON metric_source_artifacts
BEGIN
  SELECT RAISE(ABORT, 'metric_source_artifact_immutable');
END;

CREATE TRIGGER trg_metric_source_artifacts_no_delete
BEFORE DELETE ON metric_source_artifacts
BEGIN
  SELECT RAISE(ABORT, 'metric_source_artifact_immutable');
END;
