import lbry from "./lbry.js";
import fetch from "isomorphic-fetch";

const querystring = require("querystring");
const { ipcRenderer } = require("electron");

const lbryio = {
  enabled: true,
  _authenticationPromise: null,
  _exchangePromise: null,
  _exchangeLastFetched: null,
};

const CONNECTION_STRING = process.env.LBRY_APP_API_URL
  ? process.env.LBRY_APP_API_URL.replace(/\/*$/, "/") // exactly one slash at the end
  : "https://api.lbry.io/";

const EXCHANGE_RATE_TIMEOUT = 20 * 60 * 1000;

const parseJSON = response => {
  return response.json();
};

const requestLbryio = (url, opts) => {
  return new Promise((resolve, reject) => {
    fetch(url, opts)
      .then(parseJSON)
      .then(response => {
        if (response.success) {
          return resolve(response.data);
        }

        if (reject) {
          return reject(new Error(response.error));
        }

        // dispatchEvent is still here despite I think
        // these code won't be called assuming reject is used.
        document.dispatchEvent(
          new CustomEvent("unhandledError", {
            detail: {
              url: url,
              opts: opts,
              message: response.error.message,
              ...(response.error.data ? { data: response.error.data } : {}),
            },
          })
        );
      })
      .catch(err => {
        reject(
          new Error(__("Something went wrong making an internal API call."))
        );
      });
  });
};

lbryio.getExchangeRates = function() {
  if (
    !lbryio._exchangeLastFetched ||
    Date.now() - lbryio._exchangeLastFetched > EXCHANGE_RATE_TIMEOUT
  ) {
    lbryio._exchangePromise = new Promise((resolve, reject) => {
      lbryio
        .call("lbc", "exchange_rate", {}, "get", true)
        .then(({ lbc_usd, lbc_btc, btc_usd }) => {
          const rates = { lbc_usd, lbc_btc, btc_usd };
          resolve(rates);
        })
        .catch(reject);
    });
    lbryio._exchangeLastFetched = Date.now();
  }
  return lbryio._exchangePromise;
};

lbryio.call = function(resource, action, params = {}, method = "get") {
  return new Promise((resolve, reject) => {
    if (!lbryio.enabled && (resource != "discover" || action != "list")) {
      console.log(__("Internal API disabled"));
      reject(new Error(__("LBRY internal API is disabled")));
      return;
    }

    lbryio
      .getAuthToken()
      .then(token => {
        const fullParams = { auth_token: token, ...params };

        let baseURL = `${CONNECTION_STRING}${resource}/${action}`;

        if (method == "get") {
          return requestLbryio(
            `${baseURL}?${querystring.stringify(fullParams)}`,
            {
              method: "GET",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
              },
            }
          );
        }

        if (method == "post") {
          return requestLbryio(baseURL, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: querystring.stringify(fullParams),
          });
        }

        reject(new Error(__("Invalid method")));
      })
      .then(data => {
        resolve(data);
      })
      .catch(reject);
  });
};

lbryio._authToken = null;

lbryio.getAuthToken = () => {
  return new Promise((resolve, reject) => {
    if (lbryio._authToken) {
      resolve(lbryio._authToken);
    } else {
      ipcRenderer.once("auth-token-response", (event, token) => {
        lbryio._authToken = token;
        return resolve(token);
      });
      ipcRenderer.send("get-auth-token");
    }
  });
};

lbryio.setAuthToken = token => {
  lbryio._authToken = token ? token.toString().trim() : null;
  ipcRenderer.send("set-auth-token", token);
};

lbryio.getCurrentUser = () => {
  return lbryio.call("user", "me");
};

lbryio.authenticate = function() {
  if (!lbryio.enabled) {
    return new Promise((resolve, reject) => {
      resolve({
        id: 1,
        language: "en",
        primary_email: "disabled@lbry.io",
        has_verified_email: true,
        is_identity_verified: true,
        is_reward_approved: false,
      });
    });
  }

  if (lbryio._authenticationPromise === null) {
    lbryio._authenticationPromise = new Promise((resolve, reject) => {
      lbryio
        .getAuthToken()
        .then(token => {
          if (!token || token.length > 60) {
            return false;
          }

          // check that token works
          return lbryio
            .getCurrentUser()
            .then(() => {
              return true;
            })
            .catch(() => {
              return false;
            });
        })
        .then(isTokenValid => {
          if (isTokenValid) {
            return;
          }

          return lbry
            .status()
            .then(status => {
              return lbryio.call(
                "user",
                "new",
                {
                  auth_token: "",
                  language: "en",
                  app_id: status.installation_id,
                },
                "post"
              );
            })
            .then(response => {
              if (!response.auth_token) {
                throw new Error(__("auth_token is missing from response"));
              }
              return lbryio.setAuthToken(response.auth_token);
            });
        })
        .then(lbryio.getCurrentUser)
        .then(resolve, reject);
    });
  }

  return lbryio._authenticationPromise;
};

lbryio.getStripeToken = () => {
  return CONNECTION_STRING.startsWith("http://localhost:")
    ? "pk_test_NoL1JWL7i1ipfhVId5KfDZgo"
    : "pk_live_e8M4dRNnCCbmpZzduEUZBgJO";
};

export default lbryio;
