// A name/port/env flag is insufficient: verify the runner's private cluster proof.
require('../backend/src/database/environment').assertTestProof();
