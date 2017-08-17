
var _ = require('lodash');

var help = require("./helpers");

var LifToken = artifacts.require("./LifToken.sol");
var LifCrowdsale = artifacts.require("./LifCrowdsale.sol");

const LOG_EVENTS = true;

contract('LifToken Crowdsale', function(accounts) {

  it("can create a Crowndsale", async function() {
    const publicPresaleStartBlock = web3.eth.blockNumber + 10,
      endPublicPresale = publicPresaleStartBlock + 10,
      startBlock = endPublicPresale + 10,
      endBlock1 = startBlock + 15,
      endBlock2 = startBlock + 20;

    let crowdsale = await LifCrowdsale.new(
      publicPresaleStartBlock, endPublicPresale,
      startBlock, endBlock1, endBlock2,
      130, 100, 110, 150,
      accounts[0], accounts[1],
      100000000,
      20000000
    );

    assert.equal(publicPresaleStartBlock, parseInt(await crowdsale.publicPresaleStartBlock.call()));
    assert.equal(endPublicPresale, parseInt(await crowdsale.publicPresaleEndBlock.call()));
    assert.equal(startBlock, parseInt(await crowdsale.startBlock.call()));
    assert.equal(endBlock1, parseInt(await crowdsale.endBlock1.call()));
    assert.equal(endBlock2, parseInt(await crowdsale.endBlock2.call()));
    assert.equal(100, parseInt(await crowdsale.rate1.call()));
    assert.equal(110, parseInt(await crowdsale.rate2.call()));
    assert.equal(accounts[0], parseInt(await crowdsale.foundationWallet.call()));
    assert.equal(accounts[1], parseInt(await crowdsale.marketMaker.call()));
    assert.equal(100000000, parseInt(await crowdsale.minCap.call()));

  });

});
