import { ajax } from '../src/ajax.js';
import { submodule } from '../src/hook.js';
import { deepAccess, logError } from '../src/utils.js';

const MODULE_NAME = 'realTimeData';
const SUBMODULE_NAME = 'pubxai';

const PUBX_LS_KEYS = {
  TIMEOUT: 'pbx:valtimeout',
  BUCKET_VALUE: 'pbx:bktval',
  FLOOR_VALUE: 'pbx:flrval'
}

function init(provider) {
  const useRtd = deepAccess(provider, 'params.useRtd');
  if (!useRtd) {
    return false;
  }
  return true;
}

function fetchDataFromURL(url) {
  return new Promise((resolve, reject) => {
    const callback = {
      success(responseText, response) {
        resolve(JSON.parse(response.response));
      },
      error(error) {
        reject(error);
      }
    };

    ajax(url, callback);
  })
}

function getDataFromLocalStorage() {
  const timeout = +window.localStorage.getItem(PUBX_LS_KEYS.TIMEOUT) || null;
  const hadTimedout = !timeout || new Date().valueOf() > timeout;

  if (hadTimedout) {
    return {
      bucketData: null,
      floorData: null
    }
  }

  const bucketData = window.localStorage.getItem(PUBX_LS_KEYS.BUCKET_VALUE) || null;
  const floorData = window.localStorage.getItem(PUBX_LS_KEYS.BUCKET_VALUE) || null;

  return {
    bucketData,
    floorData
  }
}

function setDataToLocalStorage(bucketData, floorData) {
  if (bucketData) {
    window.localStorage.setItem(PUBX_LS_KEYS.BUCKET_VALUE, JSON.stringify(bucketData));
  }

  if (floorData) {
    window.localStorage.setItem(PUBX_LS_KEYS.FLOOR_VALUE, JSON.stringify(floorData));
  }

  const timeout = new Date().valueOf() + 86400000;
  window.localStorage.setItem(PUBX_LS_KEYS.TIMEOUT, timeout);
}

function setDataToConfig(url) {
  const {bucketData, floorData} = getDataFromLocalStorage();
  
  if (bucketData && floorData) {
    window.__PBXCNFG__.prb = bucketData;
    window.__PBXCNFG__.flrs = floorData;
  } else {
    fetchDataFromURL(url)
      .then(response => {
        const { bucket, ...floorValues} = response;
        setDataToLocalStorage(bucket, floorValues)
        window.__PBXCNFG__.prb = bucket;
        window.__PBXCNFG__.flrs = floorValues;
      })
      .catch(err => {
        logError('pubX API Fetch Error: ', err);
      })
  }

}

function getBidRequestData(reqBidsConfigObj, callback, config, userConsent) {
  const endpoint = deepAccess(config, 'params.endpoint');
  setDataToConfig(endpoint);
}

export const pubxaiSubmodule = {
  name: SUBMODULE_NAME,
  init,
  getBidRequestData,
};

export function beforeInit() {
  submodule(MODULE_NAME, pubxaiSubmodule);
}

beforeInit();
