import adapter from '../libraries/analyticsAdapter/AnalyticsAdapter.js';
import {
  getGptSlotInfoForAdUnitCode,
  getGptSlotForAdUnitCode,
} from '../libraries/gptUtils/gptUtils.js';
import {
  getDeviceType,
  getBrowser,
  getOS,
} from '../libraries/userAgentUtils/index.js';
import { MODULE_TYPE_ANALYTICS } from '../src/activities/modules.js';
import adapterManager from '../src/adapterManager.js';
import { sendBeacon } from '../src/ajax.js';
import { EVENTS } from '../src/constants.js';
import { getGlobal } from '../src/prebidGlobal.js';
import { getStorageManager } from '../src/storageManager.js';
import {
  deepAccess,
  parseSizesInput,
  getWindowLocation,
  buildUrl,
  cyrb53Hash,
} from '../src/utils.js';

let initOptions;

const emptyUrl = '';
const analyticsType = 'endpoint';
const adapterCode = 'pubxai';
const pubxaiAnalyticsVersion = 'v2.1.0';
const defaultHost = 'api.pbxai.com';
const auctionPath = '/analytics/auction';
const winningBidPath = '/analytics/bidwon';
let refreshRank = 0;
const storage = getStorageManager({
  moduleType: MODULE_TYPE_ANALYTICS,
  moduleName: adapterCode,
});

/**
 * The sendCache is a global cache object which tracks the pending sends
 * back to pubx.ai. The data may be removed from this cache, post send.
 */
export const sendCache = new Proxy(
  {},
  {
    get: (target, name) => {
      if (!target.hasOwnProperty(name)) {
        target[name] = [];
      }
      return target[name];
    },
  }
);

/**
 * auctionCache is a global cache object which stores all auction histories
 * for the session. When getting a key from the auction cache, any
 * information already known about the auction or associated data (floor
 * data configured by prebid, browser data, user data etc) is added to
 * the cache automatically.
 */
export const auctionCache = new Proxy(
  {},
  {
    get: (target, name) => {
      if (!target.hasOwnProperty(name)) {
        target[name] = {
          bids: [],
          auctionDetail: {
            refreshRank: refreshRank++,
            auctionId: name,
          },
          floorDetail: {},
          pageDetail: {
            host: getWindowLocation().host,
            path: getWindowLocation().pathname,
            search: getWindowLocation().search,
          },
          deviceDetail: {
            platform: navigator.platform,
            deviceType: getDeviceType(),
            deviceOS: getOS(),
            browser: getBrowser(),
          },
          userDetail: {
            userIdTypes: Object.keys(getGlobal().getUserIds?.() || {}),
          },
          consentDetail: {
            consentTypes: Object.keys(getGlobal().getConsentMetadata?.() || {}),
          },
          pmacDetail:
            JSON.parse(storage.getDataFromLocalStorage('pubx:pmac')) || {}, // {auction_1: {floor:0.23,maxBid:0.34,bidCount:3},auction_2:{floor:0.13,maxBid:0.14,bidCount:2}
          extraData:
            JSON.parse(storage.getDataFromLocalStorage('pubx:extraData')) || {},
          initOptions: {
            ...initOptions,
            auctionId: name, // back-compat
          },
          sendAs: [],
        };
      }
      return target[name];
    },
  }
);

/**
 * Fetch extra ad server data for a specific ad slot (bid)
 * @param {object} bid an output from extractBid
 * @returns {object} key value pairs from the adserver
 */
const getAdServerDataForBid = (bid) => {
  const adunitCode = bid.adUnitCode || '';
  const gptSlot = getGptSlotForAdUnitCode(adunitCode);
  if (!gptSlot) {
    return {};
  }
  return Object.fromEntries(
    gptSlot
      .getTargetingKeys()
      .filter(
        (key) =>
          key.startsWith('pubx-') ||
          (key.startsWith('hb_') && (key.match(/_/g) || []).length === 1)
      )
      .map((key) => [key, gptSlot.getTargeting(key)])
  );
};

/**
 * extracts and derives valuable data from a prebid bidder bidResponse object
 * @param {object} bidResponse a prebid bidder bidResponse (see
 * https://docs.prebid.org/dev-docs/publisher-api-reference/getBidResponses.html)
 * @returns {object}
 */
const extractBid = (bidResponse) => {
  return {
    adUnitCode: bidResponse.adUnitCode,
    gptSlotCode:
      getGptSlotInfoForAdUnitCode(bidResponse.adUnitCode).gptSlot || null,
    auctionId: bidResponse.auctionId,
    bidderCode: bidResponse.bidder,
    cpm: bidResponse.cpm,
    creativeId: bidResponse.creativeId,
    dealId: bidResponse.dealId,
    currency: bidResponse.currency,
    floorData: bidResponse.floorData,
    mediaType: bidResponse.mediaType,
    netRevenue: bidResponse.netRevenue,
    requestTimestamp: bidResponse.requestTimestamp,
    responseTimestamp: bidResponse.responseTimestamp,
    status: bidResponse.status,
    sizes: parseSizesInput(bidResponse.size).toString(),
    statusMessage: bidResponse.statusMessage,
    timeToRespond: bidResponse.timeToRespond,
    transactionId: bidResponse.transactionId,
    bidId: bidResponse.bidId || bidResponse.requestId,
    placementId: bidResponse.params
      ? deepAccess(bidResponse, 'params.0.placementId')
      : null,
    source: bidResponse.source || 'null',
  };
};

/**
 * Track the events emitted by prebid and handle each case. See https://docs.prebid.org/dev-docs/publisher-api-reference/getEvents.html for more info
 * @param {object} event the prebid event emmitted
 * @param {string} event.eventType the type of the event
 * @param {object} event.args the arguments of the emitted event
 */
const track = ({ eventType, args }) => {
  switch (eventType) {
    // handle invalid bids, and remove them from the adUnit cache
    case EVENTS.BID_TIMEOUT:
      args.map(extractBid).forEach((bid) => {
        bid.bidType = 3;
        auctionCache[bid.auctionId].bids.push(bid);
      });
      break;
    // handle valid bid responses and record them as part of an auction
    case EVENTS.BID_RESPONSE:
      const bid = Object.assign(extractBid(args), { bidType: 2 });
      auctionCache[bid.auctionId].bids.push(bid);
      break;
    case EVENTS.BID_REJECTED:
      const rejectedBid = Object.assign(extractBid(args), { bidType: 1 });
      auctionCache[rejectedBid.auctionId].bids.push(rejectedBid);
      break;
    // capture extra information from the auction, and if there were no bids
    // (and so no chance of a win) send the auction
    case EVENTS.AUCTION_END:
      Object.assign(
        auctionCache[args.auctionId].floorDetail,
        args.adUnits
          .map((i) => i?.bids.length && i.bids[0]?.floorData)
          .find((i) => i) || {}
      );
      auctionCache[args.auctionId].deviceDetail.cdep = args.bidderRequests
        .map((bidRequest) => bidRequest.ortb2?.device?.ext?.cdep)
        .find((i) => i);
      Object.assign(auctionCache[args.auctionId].auctionDetail, {
        adUnitCodes: args.adUnits.map((i) => i.code),
        timestamp: args.timestamp,
      });
      prepareAuctionSend(args.auctionId);
      break;
    // send the prebid winning bid back to pubx
    case EVENTS.BID_WON:
      const winningBid = extractBid(args);
      const floorDetail = auctionCache[winningBid.auctionId].floorDetail;
      Object.assign(winningBid, {
        floorProvider: floorDetail?.floorProvider || null,
        floorFetchStatus: floorDetail?.fetchStatus || null,
        floorLocation: floorDetail?.location || null,
        floorModelVersion: floorDetail?.modelVersion || null,
        floorSkipRate: floorDetail?.skipRate || 0,
        isFloorSkipped: floorDetail?.skipped || false,
        isWinningBid: true,
        renderedSize: args.size,
        bidType: 4,
      });
      winningBid.adServerData = getAdServerDataForBid(winningBid);
      auctionCache[winningBid.auctionId].winningBid = winningBid;
      prepareSendWinningBids(winningBid);
      break;
    // do nothing
    default:
      break;
  }
};

/**
 * Determines if an event should be sent to PubxAI based on sampling rate
 * @param {string} auctionId - Prebid Auction ID
 * @param {number} samplingRate - The sampling rate to apply (default: 1)
 * @returns {boolean} - True if the event should be sent, false otherwise
 */
const shouldFireEventRequest = (auctionId, samplingRate = 1) => {
  return parseInt(cyrb53Hash(auctionId)) % samplingRate === 0;
};

/**
 * Stores event data in the send cache for later transmission
 * @param {Object} eventData - Information about the event type and required data
 * @param {string[]} eventData.requiredKeys - Keys required to be present in the auction data
 * @param {string} eventData.path - API endpoint path for this event type
 * @param {Object} auctionData - The auction data to be sent
 */
const storeDataInSendCache = (eventData, auctionData) => {
  if (!eventData.requiredKeys.every((key) => !!auctionData[key])) {
    return;
  }

  const pubxaiAnalyticsRequestUrl = buildUrl({
    protocol: 'https',
    hostname:
      (auctionData.initOptions && auctionData.initOptions.hostName) ||
      defaultHost,
    pathname: eventData.path,
    search: {
      auctionTimestamp: auctionData.auctionDetail.timestamp,
      pubxaiAnalyticsVersion: pubxaiAnalyticsVersion,
      prebidVersion: '$prebid.version$',
      pubxId: initOptions.pubxId,
    },
  });

  const data = Object.fromEntries(
    eventData.requiredKeys.map((key) => [key, auctionData[key]])
  );

  sendCache[pubxaiAnalyticsRequestUrl].push(data);
};

/**
 * Prepares winning bid data to be sent to PubxAI
 * @param {Object} winningBid - The winning bid object
 */
const prepareSendWinningBids = (winningBid) => {
  const { auctionId } = winningBid;

  if (!shouldFireEventRequest(auctionId)) return;

  const auctionData = Object.assign({}, auctionCache[auctionId]);

  auctionData.winningBid = winningBid;

  const eventData = {
    path: winningBidPath,
    requiredKeys: [
      'winningBid',
      'pageDetail',
      'deviceDetail',
      'floorDetail',
      'auctionDetail',
      'userDetail',
      'consentDetail',
      'pmacDetail',
      'extraData',
      'initOptions',
    ],
    eventType: 'win',
  };

  storeDataInSendCache(eventData, auctionData);
};

/**
 * Prepares auction data to be sent to PubxAI
 * @param {string} auctionId - Prebid auction ID for the auction to prepare for sending
 */
const prepareAuctionSend = (auctionId) => {
  if (!shouldFireEventRequest(auctionId)) return;

  const auctionData = Object.assign({}, auctionCache[auctionId]);
  const eventData = {
    path: auctionPath,
    requiredKeys: [
      'bids',
      'pageDetail',
      'deviceDetail',
      'floorDetail',
      'auctionDetail',
      'userDetail',
      'consentDetail',
      'pmacDetail',
      'extraData',
      'initOptions',
    ],
    eventType: 'auction',
  };

  if (auctionCache[auctionId].sendAs.includes(eventData.eventType)) return;

  storeDataInSendCache(eventData, auctionData);
  auctionCache[auctionId].sendAs.push(eventData.eventType);
};

/**
 * Sends all cached events to PubxAI endpoints
 * Handles chunking large payloads to stay under size limits
 */
const send = () => {
  const toBlob = (d) => new Blob([JSON.stringify(d)], { type: 'text/json' });

  Object.entries(sendCache).forEach(([requestUrl, events]) => {
    let payloadStart = 0;

    events.forEach((event, index, arr) => {
      const payload = arr.slice(payloadStart, index + 2);
      const payloadTooLarge = toBlob(payload).size > 65536;

      if (payloadTooLarge || index + 1 === arr.length) {
        sendBeacon(
          requestUrl,
          toBlob(payloadTooLarge ? payload.slice(0, -1) : payload)
        );
        payloadStart = index;
      }
    });

    events.splice(0);
  });
};

// register event listener to send logs when user leaves page
if (document.visibilityState) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      send();
    }
  });
}

/**
 * PubxAI Analytics adapter for Prebid.js
 * Tracks auction events and sends data to PubxAI for analytics
 */
var pubxaiAnalyticsAdapter = Object.assign(
  adapter({
    emptyUrl,
    analyticsType,
  }),
  { track }
);

// Store the original enableAnalytics function
pubxaiAnalyticsAdapter.originEnableAnalytics =
  pubxaiAnalyticsAdapter.enableAnalytics;

/**
 * Custom enableAnalytics implementation that captures configuration options
 * @param {Object} config - The analytics adapter configuration
 * @param {Object} config.options - PubxAI specific configuration options
 */
pubxaiAnalyticsAdapter.enableAnalytics = (config) => {
  initOptions = config.options;
  // Reset the refreshRank to 0
  refreshRank = 0;
  pubxaiAnalyticsAdapter.originEnableAnalytics(config);
};

adapterManager.registerAnalyticsAdapter({
  adapter: pubxaiAnalyticsAdapter,
  code: adapterCode,
});

export default pubxaiAnalyticsAdapter;
