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
