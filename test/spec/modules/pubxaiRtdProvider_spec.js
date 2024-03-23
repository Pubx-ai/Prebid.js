import * as priceFloors from "../../../modules/priceFloors";
import {
  beforeInit,
  fetchFloorRules,
  getFloorsConfig,
  pubxaiSubmodule,
  setDefaultPriceFloors,
  setFloorsConfig,
  setPriceFloors,
} from "../../../modules/pubxaiRtdProvider";
import { config } from "../../../src/config";
import * as hook from "../../../src/hook.js";

const getConfig = () => ({
  params: {
    useRtd: true,
    endpoint: "http://pubxai.com:3001/floors",
    data: {
      currency: "EUR",
      floorProvider: "PubxFloorProvider",
      modelVersion: "gpt-mvm_AB_0.50_dt_0.75_dwt_0.95_dnt_0.25_fm_0.50",
      schema: { fields: ["gptSlot", "mediaType"] },
      values: { "*|banner": 0.02 },
    },
  },
});

const getFloorsResponse = () => ({
  currency: "USD",
  floorProvider: "PubxFloorProvider",
  modelVersion: "gpt-mvm_AB_0.50_dt_0.75_dwt_0.95_dnt_0.25_fm_0.50",
  schema: { fields: ["gptSlot", "mediaType"] },
  values: { "*|banner": 0.02 },
});

const resetGlobals = () => {
  window.__pubxLoaded__ = undefined;
  window.__pubxPrevFloorsConfig__ = undefined;
  window.__pubxFloorsConfig__ = undefined;
  window.__pubxFloorRulesPromise__ = null;
};

const fakeServer = (
  fakeResponse = "",
  providerConfig = undefined,
  statusCode = 200
) => {
  const fakeResponseHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  const fakeServer = sinon.createFakeServer();
  fakeServer.respondImmediately = true;
  fakeServer.autoRespond = true;
  fakeServer.respondWith(
    "GET",
    providerConfig ? providerConfig.params.endpoint : "*",
    [
      statusCode,
      fakeResponseHeaders,
      fakeResponse ? JSON.stringify(fakeResponse) : "",
    ]
  );
  return fakeServer;
};

const stubConfig = () => {
  const stub = sinon.stub(config, "setConfig");
  return stub;
};

describe("pubxaiRtdProvider", () => {
  describe("beforeInit", () => {
    it("should register RTD submodule provider", function () {
      let submoduleStub = sinon.stub(hook, "submodule");
      beforeInit();
      assert(submoduleStub.calledOnceWith("realTimeData", pubxaiSubmodule));
      submoduleStub.restore();
    });
  });
  describe("submodule", () => {
    describe("name", function () {
      it("should be pubxai", function () {
        expect(pubxaiSubmodule.name).to.equal("pubxai");
      });
    });
  });
  describe("init", () => {
    let stub;
    beforeEach(() => {
      resetGlobals();
      stub = stubConfig();
    });
    afterEach(() => {
      stub.restore();
    });
    it("will return true when `useRtd` is true in the provider config", () => {
      const initResult = pubxaiSubmodule.init({ params: { useRtd: true } });
      expect(initResult).to.be.true;
    });
    it("will return false when `useRtd` is false in the provider config", () => {
      const initResult = pubxaiSubmodule.init({ params: { useRtd: false } });
      expect(initResult).to.be.false;
    });
    it("setPriceFloors called when `useRtd` is true in the provider config", () => {
      pubxaiSubmodule.init(getConfig());
      expect(window.__pubxLoaded__).to.equal(true);
    });
  });
  describe("getBidRequestData", () => {
    const reqBidsConfigObj = {
      adUnits: [{ code: "ad-slot-code-0" }],
      auctionId: "auction-id-0",
    };
    let stub;
    beforeEach(() => {
      window.__pubxFloorRulesPromise__ = Promise.resolve();
      stub = sinon.stub(priceFloors, "createFloorsDataForAuction");
    });
    afterEach(() => {
      resetGlobals();
      stub.restore();
    });
    it("createFloorsDataForAuction called once before and once after __pubxFloorRulesPromise__. Also getBidRequestData executed only once", async () => {
      pubxaiSubmodule.getBidRequestData(reqBidsConfigObj, () => {});
      assert(priceFloors.createFloorsDataForAuction.calledOnce);
      await window.__pubxFloorRulesPromise__;
      assert(priceFloors.createFloorsDataForAuction.calledTwice);
      assert(
        priceFloors.createFloorsDataForAuction.alwaysCalledWith(
          reqBidsConfigObj.adUnits,
          reqBidsConfigObj.auctionId
        )
      );
      pubxaiSubmodule.getBidRequestData(reqBidsConfigObj, () => {});
      await window.__pubxFloorRulesPromise__;
      assert(priceFloors.createFloorsDataForAuction.calledTwice);
    });
  });
  describe("fetchFloorRules", () => {
    const providerConfig = getConfig();
    const floorsResponse = getFloorsResponse();
    let server;
    afterEach(() => {
      server.restore();
    });
    it("success with floors response", async () => {
      server = fakeServer(floorsResponse);
      const res = await fetchFloorRules(providerConfig);
      expect(res).to.deep.equal(floorsResponse);
    });
    it("success with no floors response", async () => {
      server = fakeServer(undefined);
      const res = await fetchFloorRules(providerConfig);
      expect(res).to.equal(null);
    });
    it("failure case", async () => {
      server = fakeServer(undefined, undefined, 404);
      try {
        const res = await fetchFloorRules(providerConfig);
        expect(true).to.be.false;
      } catch (e) {
        expect(e).to.not.be.undefined;
      }
    });
  });
  describe("setPriceFloors", () => {
    const providerConfig = getConfig();
    const floorsResponse = getFloorsResponse();
    let server, stub;
    beforeEach(() => {
      resetGlobals();
      stub = stubConfig();
    });
    afterEach(() => {
      server.restore();
      stub.restore();
    });
    it("with floors response", async () => {
      server = fakeServer(floorsResponse);
      const floorsPromise = setPriceFloors(providerConfig);
      expect(window.__pubxLoaded__).to.be.true;
      expect(window.__pubxFloorsConfig__).to.deep.equal(
        getFloorsConfig(providerConfig, providerConfig.params.data)
      );
      await floorsPromise;
      expect(window.__pubxLoaded__).to.be.true;
      expect(window.__pubxFloorsConfig__).to.deep.equal(
        getFloorsConfig(providerConfig, floorsResponse)
      );
    });
    it("without floors response", async () => {
      server = fakeServer(undefined);
      const floorsPromise = setPriceFloors(providerConfig);
      expect(window.__pubxLoaded__).to.be.true;
      expect(window.__pubxFloorsConfig__).to.deep.equal(
        getFloorsConfig(providerConfig, providerConfig.params.data)
      );
      await floorsPromise;
      expect(window.__pubxLoaded__).to.be.false;
      expect(window.__pubxFloorsConfig__).to.deep.equal(null);
    });
    it("default floors", async () => {
      server = fakeServer(undefined, undefined, 404);
      const floorsPromise = setPriceFloors(providerConfig);
      expect(window.__pubxLoaded__).to.be.true;
      expect(window.__pubxFloorsConfig__).to.deep.equal(
        getFloorsConfig(providerConfig, providerConfig.params.data)
      );
      try {
        await floorsPromise;
        expect(true).to.be.false;
      } catch (e) {
        expect(window.__pubxLoaded__).to.be.true;
        expect(window.__pubxFloorsConfig__).to.deep.equal(
          getFloorsConfig(providerConfig, providerConfig.params.data)
        );
      }
    });
  });
  describe("setFloorsConfig", () => {
    const providerConfig = getConfig();
    let stub;
    beforeEach(() => {
      resetGlobals();
      stub = stubConfig();
    });
    afterEach(function () {
      stub.restore();
    });
    it("non-empty floorResponse", () => {
      const floorsResponse = getFloorsResponse();
      setFloorsConfig(providerConfig, floorsResponse);
      const floorsConfig = getFloorsConfig(providerConfig, floorsResponse);
      assert(config.setConfig.calledOnceWith(floorsConfig));
      expect(window.__pubxLoaded__).to.be.true;
      expect(window.__pubxFloorsConfig__).to.deep.equal(floorsConfig);
    });
    it("empty floorResponse", () => {
      const floorsResponse = null;
      setFloorsConfig(providerConfig, floorsResponse);
      assert(config.setConfig.calledOnceWith({ floors: undefined }));
      expect(window.__pubxLoaded__).to.be.false;
      expect(window.__pubxFloorsConfig__).to.be.null;
    });
  });
  describe("getFloorsConfig", () => {
    let providerConfig;
    const floorsResponse = getFloorsResponse();
    beforeEach(() => {
      providerConfig = getConfig();
    });
    it("no customizations in the provider config", () => {
      const result = getFloorsConfig(providerConfig, floorsResponse);
      expect(result).to.deep.equal({
        floors: {
          enforcement: { floorDeals: true },
          data: floorsResponse,
        },
      });
    });
    it("only floormin in the provider config", () => {
      providerConfig.params.floorMin = 2;
      expect(getFloorsConfig(providerConfig, floorsResponse)).to.deep.equal({
        floors: {
          enforcement: { floorDeals: true },
          floorMin: 2,
          data: floorsResponse,
        },
      });
    });
    it("only enforcement in the provider config", () => {
      providerConfig.params.enforcement = {
        bidAdjustment: true,
        enforceJS: false,
      };
      expect(getFloorsConfig(providerConfig, floorsResponse)).to.deep.equal({
        floors: {
          enforcement: {
            bidAdjustment: true,
            enforceJS: false,
          },
          data: floorsResponse,
        },
      });
    });
    it("both floorMin and enforcement in the provider config", () => {
      providerConfig.params.floorMin = 2;
      providerConfig.params.enforcement = {
        bidAdjustment: true,
        enforceJS: false,
      };
      expect(getFloorsConfig(providerConfig, floorsResponse)).to.deep.equal({
        floors: {
          enforcement: {
            bidAdjustment: true,
            enforceJS: false,
          },
          floorMin: 2,
          data: floorsResponse,
        },
      });
    });
  });
  describe("setDefaultPriceFloors", () => {
    let stub;
    beforeEach(() => {
      resetGlobals();
      stub = stubConfig();
    });
    afterEach(function () {
      stub.restore();
    });
    it("should set default floors config", () => {
      const providerConfig = getConfig();
      setDefaultPriceFloors(providerConfig);
      assert(
        config.setConfig.calledOnceWith(
          getFloorsConfig(providerConfig, providerConfig.params.data)
        )
      );
      expect(window.__pubxLoaded__).to.be.true;
    });
  });
});
