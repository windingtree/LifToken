var _ = require('lodash');
var jsc = require('jsverify');

var BigNumber = web3.BigNumber;

var help = require('./helpers');
var latestTime = require('./helpers/latestTime');
var { increaseTimeTestRPC, duration } = require('./helpers/increaseTime');

var LifToken = artifacts.require('LifToken.sol');
var LifCrowdsale = artifacts.require('LifCrowdsale.sol');

let gen = require('./generators');
let commands = require('./commands');

const LOG_EVENTS = true;

let GEN_TESTS_QTY = parseInt(process.env.GEN_TESTS_QTY);
if (isNaN(GEN_TESTS_QTY)) { GEN_TESTS_QTY = 50; }

let GEN_TESTS_TIMEOUT = parseInt(process.env.GEN_TESTS_TIMEOUT);
if (isNaN(GEN_TESTS_TIMEOUT)) { GEN_TESTS_TIMEOUT = 300; }

contract('LifCrowdsale Property-based test', function (accounts) {
  const zero = new BigNumber(0);

  let crowdsaleTestInputGen = jsc.record({
    commands: jsc.array(jsc.nonshrink(commands.commandsGen)),
    crowdsale: jsc.nonshrink(gen.crowdsaleGen),
  });

  let sumBigNumbers = (arr) => _.reduce(arr, (accum, x) => accum.plus(x), zero);

  let checkCrowdsaleState = async function (state, crowdsaleData, crowdsale) {
    assert.equal(state.crowdsalePaused, await crowdsale.paused());

    let tokensInPurchases = sumBigNumbers(_.map(state.purchases, (p) => p.tokens));
    tokensInPurchases.should.be.bignumber.equal(help.lifWei2Lif(await crowdsale.tokensSold()));

    let presaleWei = sumBigNumbers(_.map(state.presalePurchases, (p) => p.wei));

    presaleWei.should.be.bignumber.equal(await crowdsale.totalPresaleWei.call());

    help.debug('checking purchases total wei, purchases:', JSON.stringify(state.purchases));
    let weiInPurchases = sumBigNumbers(_.map(state.purchases, (p) => p.wei));
    weiInPurchases.should.be.bignumber.equal(await crowdsale.weiRaised());

    // Check presale tokens sold
    state.totalPresaleWei.should.be.bignumber.equal(await crowdsale.totalPresaleWei.call());
    assert.equal(state.crowdsaleFinalized, await crowdsale.isFinalized.call());
    if (state.crowdsaleFinalized && state.weiPerUSDinTGE > 0) {
      assert.equal(state.crowdsaleFunded, await crowdsale.funded());
    }

    // TODO: check claimed eth amount
    //
    // check eth balances
    // const getBalancePromise = (address) => new Promise(function (accept, reject) {
    //   return web3.eth.getBalance(address, function (err, balance) {
    //     if (err) return reject(err);
    //     accept(balance);
    //   });
    // });
    //
    // const balancesAndPromises = _.map(state.ethBalances,
    //   (balance, accountIndex) => [balance, getBalancePromise(gen.getAccount(accountIndex))]);

    // TO DO: Fix the check of balances, it is broken due to wrong gas calculation, maybe from testrpc
    // _.forEach(balancesAndPromises, async ([balanceInState, balancePromise]) => {
    //   const balanceFromWeb3 = await balancePromise;
    //
    //   return balanceInState.should.be.bignumber.equal(balanceFromWeb3);
    // });

    help.debug('check total supply');
    state.totalSupply.should.be.bignumber.equal(await state.token.totalSupply.call());

    help.debug('check burned tokens');
    if (state.crowdsaleFinalized) {
      state.burnedTokens.plus(await state.token.totalSupply())
        .should.be.bignumber.equal(state.initialTokenSupply);
    } else {
      state.burnedTokens.should.be.bignumber.equal(0);
    }

    help.debug('check MVM');
    if (state.MVM !== undefined) {
      state.MVMBurnedTokens.should.be.bignumber.equal(await state.MVM.totalBurnedTokens.call());
      assert.equal(state.MVMPaused, await state.MVM.paused.call());
      state.MVMPausedSeconds.should.be.bignumber.equal(await state.MVM.totalPausedSeconds.call());
      state.MVMClaimedWei.should.be.bignumber.equal(await state.MVM.totalWeiClaimed.call());
      state.returnedWeiForBurnedTokens.should.be.bignumber.equal(await state.MVM.totalReimbursedWei.call());
      if ((latestTime() >= state.MVMStartTimestamp) && !help.inCoverage()) {
        assert.equal(state.MVMMonth, parseInt(await state.MVM.getCurrentPeriodIndex()));
      }
    } else {
      state.MVMBurnedTokens.should.be.bignumber.equal(0);
      state.MVMPausedSeconds.should.be.bignumber.equal(0);
    }
  };

  let runGeneratedCrowdsaleAndCommands = async function (input) {
    await increaseTimeTestRPC(60);
    let startTimestamp = latestTime() + duration.days(1);
    let end1Timestamp = startTimestamp + duration.days(1);
    let end2Timestamp = end1Timestamp + duration.days(1);

    help.debug('crowdsaleTestInput data:\n', input, startTimestamp, end1Timestamp, end2Timestamp);

    let { rate1, rate2, owner, setWeiLockSeconds } = input.crowdsale,
      ownerAddress = gen.getAccount(input.crowdsale.owner),
      foundationWallet = gen.getAccount(input.crowdsale.foundationWallet),
      foundersWallet = gen.getAccount(input.crowdsale.foundersWallet);
    let shouldThrow = (rate1 === 0) ||
      (rate2 === 0) ||
      (latestTime() >= startTimestamp) ||
      (startTimestamp >= end1Timestamp) ||
      (end1Timestamp >= end2Timestamp) ||
      (setWeiLockSeconds === 0) ||
      (ownerAddress === 0) ||
      (foundationWallet === 0) ||
      (foundersWallet === 0);

    var eventsWatcher;

    try {
      let crowdsaleData = {
        startTimestamp: startTimestamp,
        end1Timestamp: end1Timestamp,
        end2Timestamp: end2Timestamp,
        rate1: input.crowdsale.rate1,
        rate2: input.crowdsale.rate2,
        setWeiLockSeconds: input.crowdsale.setWeiLockSeconds,
        foundationWallet: gen.getAccount(input.crowdsale.foundationWallet),
        foundersWallet: gen.getAccount(input.crowdsale.foundersWallet),
        minCapUSD: 5000000,
        maxFoundationCapUSD: 10000000,
        MVM24PeriodsCapUSD: 40000000,
      };

      let crowdsale = await LifCrowdsale.new(
        crowdsaleData.startTimestamp,
        crowdsaleData.end1Timestamp,
        crowdsaleData.end2Timestamp,
        crowdsaleData.rate1,
        crowdsaleData.rate2,
        crowdsaleData.setWeiLockSeconds,
        crowdsaleData.foundationWallet,
        crowdsaleData.foundersWallet,
        { from: ownerAddress }
      );

      assert.equal(false, shouldThrow, 'create Crowdsale should have thrown but it did not');

      let token = LifToken.at(await crowdsale.token());

      eventsWatcher = crowdsale.allEvents();
      eventsWatcher.watch(function (error, log) {
        if (LOG_EVENTS) {
          if (error) {
            console.log('Error in event:', error);
          } else {
            console.log('Event:', log.event, ':', log.args);
          }
        }
      });

      help.debug('created crowdsale at address ', crowdsale.address);

      var state = {
        crowdsaleData: crowdsaleData,
        crowdsaleContract: crowdsale,
        foundationWallet: input.crowdsale.foundationWallet,
        token: token,
        balances: {},
        ethBalances: help.getAccountsBalances(accounts),
        allowances: {},
        purchases: [],
        presalePurchases: [],
        claimedEth: {},
        weiRaised: zero,
        totalPresaleWei: zero,
        crowdsalePaused: false,
        tokenPaused: true,
        crowdsaleFinalized: false,
        weiPerUSDinTGE: 0,
        crowdsaleFunded: false,
        owner: owner,
        totalSupply: zero,
        initialTokenSupply: zero,
        MVMBuyPrice: new BigNumber(0),
        MVMBurnedTokens: new BigNumber(0),
        MVMClaimedWei: zero,
        claimablePercentage: zero,
        MVMMonth: -1, // start as -1, as if the MVM didn't start yet
        MVMPaused: false,
        MVMPausedSeconds: zero,
        burnedTokens: zero,
        returnedWeiForBurnedTokens: new BigNumber(0),
      };

      for (let commandParams of input.commands) {
        let command = commands.findCommand(commandParams.type);
        try {
          state = await command.run(commandParams, state);
        } catch (error) {
          help.debug('An error occurred, block timestamp: ' + latestTime() + '\nError: ' + error);
          if (error instanceof commands.ExceptionRunningCommand) {
            throw (new Error(
              error.message + '\n\nUse the following to reproduce the failure:\n\n' +
              'await runGeneratedCrowdsaleAndCommands(' +
              JSON.stringify(input, null, 2) + ');'
            ));
          } else { throw (error); }
        }
      }

      // check resulting in-memory and contract state
      await checkCrowdsaleState(state, crowdsaleData, crowdsale);
    } catch (e) {
      if (!shouldThrow) {
        // only re-throw if we were not expecting this exception
        throw (e);
      }
    } finally {
      if (eventsWatcher) {
        eventsWatcher.stopWatching();
      }
    }

    return true;
  };

  it('does not fail on some specific examples that once failed', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'waitTime', 'seconds': duration.days(1) },
        { 'type': 'sendTransaction', 'account': 3, 'beneficiary': 0, 'eth': 9 },
      ],
      crowdsale: {
        rate1: 18,
        rate2: 33,
        foundationWallet: 1,
        foundersWallet: 2,
        setWeiLockSeconds: 600,
        owner: 7,
      },
    });

    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'waitTime', 'seconds': duration.days(2.6) },
        { 'type': 'pauseCrowdsale', 'pause': true, 'fromAccount': 8 },
        { 'type': 'sendTransaction', 'account': 0, 'beneficiary': 9, 'eth': 39 },
      ],
      crowdsale: {
        rate1: 39,
        rate2: 13,
        foundationWallet: 8,
        foundersWallet: 2,
        setWeiLockSeconds: 600,
        owner: 9,
      },
    });

    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleBelowSoftCap', 'account': 7, 'finalize': false },
      ],
      crowdsale: {
        rate1: 33,
        rate2: 12,
        foundationWallet: 10,
        foundersWallet: 2,
        setWeiLockSeconds: 52,
        owner: 0,
      },
    });
  });

  it('does not fail when running a fund over soft cap and then one below soft cap commands', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 7, 'softCapExcessWei': 7, 'finalize': false },
        { 'type': 'fundCrowdsaleBelowSoftCap', 'account': 10, 'finalize': true },
      ],
      crowdsale: {
        rate1: 10,
        rate2: 27,
        foundationWallet: 0,
        foundersWallet: 2,
        setWeiLockSeconds: 392,
        owner: 5,
      },
    });
  });

  it('does not fail when funding below soft cap and then sending tokens to the MVM', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleBelowSoftCap', 'account': 10, 'finalize': true },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 8 },
        { 'type': 'MVMSendTokens', 'tokens': 3, 'from': 10 },
      ],
      crowdsale: {
        rate1: 9,
        rate2: 1,
        foundationWallet: 0,
        foundersWallet: 2,
        setWeiLockSeconds: 600,
        owner: 8,
      },
    });
  });

  it('calculates correct rate on the boundaries between end1Timestamp and end2Timestamp', async function () {
    let crowdsaleAndCommands = {
      commands: [
        { 'type': 'checkRate' },
        { 'type': 'waitTime', 'seconds': duration.minutes(1430) },
        { 'type': 'setWeiPerUSDinTGE', wei: 3000000000000000, fromAccount: 3 },
        { 'type': 'checkRate' },
        { 'type': 'waitTime', 'seconds': duration.days(2.9) },
        { 'type': 'buyTokens', beneficiary: 3, account: 2, eth: 12 },
      ],
      crowdsale: {
        rate1: 16,
        rate2: 14,
        setWeiLockSeconds: 3600,
        foundationWallet: 2,
        foundersWallet: 2,
        owner: 3,
      },
    };

    await runGeneratedCrowdsaleAndCommands(crowdsaleAndCommands);
  });

  it('Execute a normal TGE', async function () {
    let crowdsaleAndCommands = {
      commands: [
        { 'type': 'checkRate' },
        { 'type': 'setWeiPerUSDinTGE', wei: 1500000000000000, fromAccount: 3 },
        { 'type': 'waitTime', 'seconds': duration.days(1) },
        { 'type': 'buyTokens', beneficiary: 3, account: 4, eth: 40000 },
        { 'type': 'waitTime', 'seconds': duration.days(1) },
        { 'type': 'buyTokens', beneficiary: 3, account: 4, eth: 23000 },
        { 'type': 'waitTime', 'seconds': duration.days(1) },
        { 'type': 'finalizeCrowdsale', fromAccount: 5 },
      ],
      crowdsale: {
        rate1: 10,
        rate2: 9,
        setWeiLockSeconds: 3600,
        foundationWallet: 2,
        foundersWallet: 2,
        owner: 3,
      },
    };

    await runGeneratedCrowdsaleAndCommands(crowdsaleAndCommands);
  });

  it('should handle the exception correctly when trying to pause the token during and after the crowdsale', async function () {
    let crowdsaleAndCommands = {
      commands: [
        { 'type': 'checkRate' },
        { 'type': 'waitTime', 'seconds': duration.days(1) },
        { 'type': 'waitTime', 'seconds': duration.days(0.8) },
        { 'type': 'pauseToken', 'pause': true, 'fromAccount': 3 },
        { 'type': 'setWeiPerUSDinTGE', wei: 1500000000000000, fromAccount: 3 },
        { 'type': 'waitTime', 'seconds': duration.days(1.1) },
        { 'type': 'buyTokens', beneficiary: 3, account: 4, eth: 60000 },
        { 'type': 'waitTime', 'seconds': duration.days(2) },
        { 'type': 'finalizeCrowdsale', fromAccount: 5 },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 3 },
      ],
      crowdsale: {
        rate1: 10,
        rate2: 9,
        setWeiLockSeconds: 5,
        foundationWallet: 2,
        foundersWallet: 3,
        owner: 3,
      },
    };

    await runGeneratedCrowdsaleAndCommands(crowdsaleAndCommands);
  });

  it('should not fail when setting wei for tge before each stage starts', async function () {
    // trying multiple commands with different reasons to fail: wrong owner or wei==0

    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'setWeiPerUSDinTGE', 'wei': 0, 'fromAccount': 10 },
        { 'type': 'setWeiPerUSDinTGE', 'wei': 0, 'fromAccount': 6 },
        { 'type': 'setWeiPerUSDinTGE', 'wei': 3, 'fromAccount': 6 },
      ],
      crowdsale: {
        rate1: 10,
        rate2: 31,
        foundationWallet: 10,
        foundersWallet: 3,
        setWeiLockSeconds: 1,
        owner: 6,
      },
    });
  });

  it('should handle the thrown exc. when trying to approve on the paused token', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [{ 'type': 'approve', 'lif': 0, 'fromAccount': 3, 'spenderAccount': 5 }],
      crowdsale: {
        rate1: 24,
        rate2: 15,
        foundationWallet: 2,
        foundersWallet: 3,
        setWeiLockSeconds: 1,
        owner: 5,
      },
    });
  });

  it('should run the fund and finalize crowdsale command fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleBelowSoftCap', 'account': 3, 'finalize': true },
      ],
      crowdsale: {
        rate1: 20,
        rate2: 46,
        foundationWallet: 4,
        foundersWallet: 2,
        setWeiLockSeconds: 521,
        owner: 0,
      },
    });
  });

  it('should run the fund crowdsale below cap without finalize command fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleBelowSoftCap', 'account': 3, 'finalize': false },
      ],
      crowdsale: {
        rate1: 20,
        rate2: 46,
        foundationWallet: 4,
        foundersWallet: 2,
        setWeiLockSeconds: 521,
        owner: 0,
      },
    });
  });

  it('should run the fund crowdsale below cap, finalize and try to approve form zero address', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleBelowSoftCap', 'account': 3, 'finalize': true },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 0 },
        { 'type': 'approve', 'lif': 0, 'fromAccount': 'zero', 'spenderAccount': 'zero' },
      ],
      crowdsale: {
        rate1: 20,
        rate2: 46,
        foundationWallet: 4,
        foundersWallet: 2,
        setWeiLockSeconds: 521,
        owner: 0,
      },
    });
  });

  it('should approve from zero spender address with lif amount > 0, and then transferFrom', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands:
      [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 10, 'softCapExcessWei': 25, 'finalize': true },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 0 },
        { 'type': 'approve', 'lif': 23, 'fromAccount': 10, 'spenderAccount': 'zero' },
        { 'type': 'transferFrom', 'lif': 23, 'fromAccount': 'zero', 'toAccount': 5, 'senderAccount': 10 },
      ],
      crowdsale: {
        rate1: 23,
        rate2: 16,
        foundationWallet: 0,
        foundersWallet: 2,
        setWeiLockSeconds: 1726,
        owner: 0,
      },
    });
  });

  it('should be able to transfer tokens in unpaused token after crowdsale funded over cap', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 10, 'softCapExcessWei': 4, 'finalize': true },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 5 },
        { 'type': 'transfer', 'lif': 0, 'fromAccount': 4, 'toAccount': 2 },
      ],
      crowdsale: {
        rate1: 14,
        rate2: 20,
        foundationWallet: 6,
        foundersWallet: 2,
        setWeiLockSeconds: 83,
        owner: 5,
      },
    });
  });

  it('should handle fund, finalize and burn with 0 tokens', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleBelowSoftCap', 'account': 3, 'finalize': true },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 1 },
        { 'type': 'burnTokens', 'account': 4, 'tokens': 0 },
      ],
      crowdsale: {
        rate1: 11,
        rate2: 13,
        foundationWallet: 3,
        foundersWallet: 2,
        setWeiLockSeconds: 2273,
        owner: 1,
      },
    });
  });

  it('should run the fund over soft cap and finalize crowdsale command fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 3, 'softCapExcessWei': 10, 'finalize': true },
      ],
      crowdsale: {
        rate1: 20,
        rate2: 46,
        foundationWallet: 4,
        foundersWallet: 2,
        setWeiLockSeconds: 521,
        owner: 0,
      },
    });
  });

  it('should run fund and finalize crowdsale below cap, the burn tokens fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleBelowSoftCap', 'account': 8, 'finalize': true },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 10 },
        { 'type': 'burnTokens', 'account': 5, 'tokens': 44 },
      ],
      crowdsale: {
        rate1: 1, rate2: 6, foundationWallet: 5, foundersWallet: 2, setWeiLockSeconds: 2176, owner: 10,
      },
    });
  });

  it('should run the fund and finalize below and over soft cap sequence fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleBelowSoftCap', 'account': 3, 'finalize': false },
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 10, 'softCapExcessWei': 15, 'finalize': false },
      ],
      crowdsale: {
        rate1: 26,
        rate2: 28,
        foundationWallet: 9,
        foundersWallet: 2,
        setWeiLockSeconds: 2696,
        owner: 6,
      },
    });
  });

  it('should fund and finalize over cap and then send tokens to MVM fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 0, 'softCapExcessWei': 32, 'finalize': true },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 9 },
        { 'type': 'MVMSendTokens', 'tokens': 4, 'from': 4 },
      ],
      crowdsale: {
        rate1: 2, rate2: 32, foundationWallet: 7, foundersWallet: 2, setWeiLockSeconds: 2098, owner: 9,
      },
    });
  });

  it('runs the fund over soft cap and finalize with 0 excess command fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 0, 'softCapExcessWei': 0, 'finalize': true },
      ],
      crowdsale: {
        rate1: 3,
        rate2: 3,
        foundationWallet: 2,
        foundersWallet: 3,
        setWeiLockSeconds: 2464,
        owner: 9,
      },
    });
  });

  it('should run fund over soft cap and finalize + claimEth sequence fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      'commands': [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 8, 'softCapExcessWei': 15, 'finalize': true },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 2 },
        { 'type': 'claimEth', 'eth': 33, 'fromAccount': 8 },
      ],
      'crowdsale': {
        'rate1': 23,
        'rate2': 40,
        'foundationWallet': 1,
        'foundersWallet': 2,
        'setWeiLockSeconds': 1445,
        'owner': 2,
      },
    });
  });

  it('should run fund over soft cap and finalize + returnPurchase sequence fine and send tokens', async function () {
    await runGeneratedCrowdsaleAndCommands({
      'commands': [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 8, 'softCapExcessWei': 15, 'finalize': true },
        { 'type': 'returnPurchase', 'eth': 1, 'fromAccount': 0, 'contributor': 8 },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 2 },
        { 'type': 'transfer', 'lif': 10, 'fromAccount': 8, 'toAccount': 2 },
      ],
      'crowdsale': {
        'rate1': 23,
        'rate2': 40,
        'foundationWallet': 1,
        'foundersWallet': 2,
        'setWeiLockSeconds': 1445,
        'owner': 2,
      },
    });
  });

  it('should run fund over soft cap and finalize + returnPurchase sequence fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      'commands': [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 8, 'softCapExcessWei': 15, 'finalize': true },
        { 'type': 'returnPurchase', 'eth': 33, 'fromAccount': 0, 'contributor': 8 },
      ],
      'crowdsale': {
        'rate1': 23,
        'rate2': 40,
        'foundationWallet': 1,
        'foundersWallet': 2,
        'setWeiLockSeconds': 1445,
        'owner': 2,
      },
    });
  });

  it('should run fund below min cap and finalize + claimEth sequence fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      'commands': [
        { 'type': 'fundCrowdsaleBelowMinCap', 'account': 8, 'fundingEth': 15, 'finalize': true },
        { 'type': 'claimEth', 'fromAccount': 8 },
      ],
      'crowdsale': {
        'rate1': 23,
        'rate2': 40,
        'foundationWallet': 1,
        'foundersWallet': 2,
        'setWeiLockSeconds': 1445,
        'owner': 2,
      },
    });
  });

  it('should fund over soft cap + MVM claim wei fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 7, 'softCapExcessWei': 13, 'finalize': true },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 10 },
        { 'type': 'MVMClaimWei', 'eth': 12 },
      ],
      crowdsale: {
        rate1: 3,
        rate2: 11,
        foundationWallet: 5,
        foundersWallet: 2,
        setWeiLockSeconds: 3152,
        owner: 10,
      },
    });
  });

  it('should fund over soft cap, do some pause/unpause, do some waiting and claim eth in the MVM fine', async function () {
    // should work fine on a paused MVM (even though it would not be able to actually claim the eth)
    // and unpausing should also work fine
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 7, 'softCapExcessWei': 13, 'finalize': true },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 10 },
        { 'type': 'MVMPause', 'pause': true, 'fromAccount': 5 },
        { 'type': 'MVMClaimWei', 'eth': 12 },
        { 'type': 'MVMWaitForMonth', 'month': 4 },
        { 'type': 'MVMPause', 'pause': false, 'fromAccount': 5 },
        { 'type': 'MVMWaitForMonth', 'month': 6 }, // to check that waitForMonth works fine with pausedSeconds > 0
      ],
      crowdsale: {
        rate1: 3,
        rate2: 11,
        foundationWallet: 5,
        foundersWallet: 2,
        setWeiLockSeconds: 3152,
        owner: 10,
      },
    });
  });

  it('runs an addPrivatePresalePayment command fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'addPrivatePresalePayment', 'beneficiaryAccount': 1, 'fromAccount': 9, 'eth': 24, 'rate': 50 },
      ],
      crowdsale: {
        rate1: 5,
        rate2: 21,
        foundationWallet: 0,
        foundersWallet: 2,
        setWeiLockSeconds: 1967,
        owner: 9,
      },
    });
  });

  it('handles fund over soft cap and add private presale payment', async function () {
    await runGeneratedCrowdsaleAndCommands({
      'commands': [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 9, 'softCapExcessWei': 1, 'finalize': false },
        { 'type': 'addPrivatePresalePayment', 'beneficiaryAccount': 4, 'fromAccount': 10, 'eth': 1, 'rate': 147 },
      ],
      'crowdsale': {
        'rate1': 18,
        'rate2': 8,
        'foundationWallet': 8,
        'foundersWallet': 10,
        'setWeiLockSeconds': 3394,
        'owner': 10,
      },
    });
  });

  it('runs funds and finalizes a crowdsale and then transfer with zero lif fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      'commands': [
        { 'type': 'fundCrowdsaleBelowSoftCap', 'account': 2, 'finalize': true },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 7 },
        { 'type': 'transfer', 'lif': 0, 'fromAccount': 'zero', 'toAccount': 7 },
      ],
      'crowdsale': {
        'rate1': 5,
        'rate2': 6,
        'foundationWallet': 5,
        'foundersWallet': 2,
        'setWeiLockSeconds': 2137,
        'owner': 7,
      },
    });
  });

  it('can try to burn tokens on a non-funded finalized crowdsale', async function () {
    await runGeneratedCrowdsaleAndCommands({
      'commands': [
        { 'type': 'fundCrowdsaleBelowSoftCap', 'account': 9, 'fundingEth': 0, 'finalize': true },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 6 },
        { 'type': 'burnTokens', 'account': 9, 'tokens': 18 },
      ],
      'crowdsale': {
        'rate1': 8, 'rate2': 20, 'foundationWallet': 1, 'foundersWallet': 6, 'setWeiLockSeconds': 687, 'owner': 6,
      },
    });
  });

  it('can fund over soft cap, wait then send tokens to MVM', async function () {
    await runGeneratedCrowdsaleAndCommands({
      'commands': [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 7, 'softCapExcessWei': 21, 'finalize': true },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 9 },
        { 'type': 'MVMWaitForMonth', month: 5 },
        { 'type': 'MVMSendTokens', 'tokens': 0.00000014, 'from': 7 },
      ],
      'crowdsale': {
        'rate1': 2,
        'rate2': 24,
        'foundationWallet': 3,
        'foundersWallet': 10,
        'setWeiLockSeconds': 1684,
        'owner': 9,
      },
    });
  });

  it('runs a fund over soft cap and MVM claim eth commands fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      'commands': [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 7, 'softCapExcessWei': 21, 'finalize': true },
        { 'type': 'MVMClaimWei', 'eth': 0 },
      ],
      'crowdsale': {
        'rate1': 18,
        'rate2': 16,
        'foundationWallet': 4,
        'foundersWallet': 0,
        'setWeiLockSeconds': 3461,
        'owner': 5,
      },
    });
  });

  it('can fund over soft cap, wait a few months and then claim eth on the MVM', async function () {
    await runGeneratedCrowdsaleAndCommands({
      'commands': [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 2, 'softCapExcessWei': 8, 'finalize': true },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 7 },
        { 'type': 'MVMWaitForMonth', 'month': 11 },
        { 'type': 'MVMClaimWei', 'eth': 4 },
      ],
      'crowdsale': {
        'rate1': 5,
        'rate2': 1,
        'foundationWallet': 5,
        'foundersWallet': 2,
        'setWeiLockSeconds': 3214,
        'owner': 7,
      },
    });
  });

  it('should be able to transfer to 0x0 account', async function () {
    await runGeneratedCrowdsaleAndCommands({
      'commands': [
        { 'type': 'fundCrowdsaleBelowSoftCap', 'account': 3, 'finalize': true },
        { 'type': 'pauseToken', 'pause': false, 'fromAccount': 1 },
        { 'type': 'transfer', 'lif': 0, 'fromAccount': 10, 'toAccount': 'zero' },
        { 'type': 'transferFrom', 'lif': 0, 'senderAccount': 5, 'fromAccount': 10, 'toAccount': 'zero' },
      ],
      'crowdsale': {
        'rate1': 4,
        'rate2': 25,
        'foundationWallet': 9,
        'foundersWallet': 7,
        'setWeiLockSeconds': 807,
        'owner': 1,
      },
    });
  });

  it('runs fund below cap, send tx and fund below cap with finalize test fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleBelowSoftCap', 'account': 10, 'fundingEth': 27, 'finalize': false },
        { 'type': 'sendTransaction', 'account': 5, 'beneficiary': 5, 'eth': 3 },
        { 'type': 'fundCrowdsaleBelowSoftCap', 'account': 8, 'finalize': true },
      ],
      crowdsale: {
        rate1: 37,
        rate2: 4,
        foundationWallet: 5,
        foundersWallet: 6,
        setWeiLockSeconds: 840,
        owner: 4,
      },
    });
  });

  it('sets wei per USD rate and funds and finalizes crowdsale fine', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'setWeiPerUSDinTGE', 'wei': 9999999143274796, 'fromAccount': 2 },
        { 'type': 'waitTime', 'seconds': duration.days(1) }, // wait until crowdsale start
        { 'type': 'buyTokens', 'beneficiary': 3, 'account': 7, 'eth': 0.000000100000000035 },
        { 'type': 'finalizeCrowdsale', 'fromAccount': 2 },
      ],
      crowdsale: {
        rate1: 33,
        rate2: 39,
        foundationWallet: 6,
        foundersWallet: 7,
        setWeiLockSeconds: 3501,
        owner: 2,
      },
    });
  });

  it('handles fund over soft cap with finalize and then pause the MVM from crowdsale owner', async function () {
    // pause actually fails because it's from the crowdsale owner instead of the foundation wallet address
    await runGeneratedCrowdsaleAndCommands({
      'commands': [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 2, 'softCapExcessWei': 2, 'finalize': true },
        { 'type': 'MVMPause', 'pause': true, 'fromAccount': 8 },
      ],
      'crowdsale': {
        'rate1': 24,
        'rate2': 15,
        'foundationWallet': 9,
        'foundersWallet': 8,
        'setWeiLockSeconds': 1532,
        'owner': 8,
      },
    });
  });

  it('runs fine when funding over soft cap with no excess wei and finalize', async function () {
    await runGeneratedCrowdsaleAndCommands({
      commands: [
        { 'type': 'fundCrowdsaleOverSoftCap', 'account': 6, 'softCapExcessWei': 0, 'finalize': true },
      ],
      crowdsale: {
        rate1: 10,
        rate2: 23,
        foundationWallet: 4,
        foundersWallet: 10,
        setWeiLockSeconds: 3405,
        owner: 5,
      },
    });
  });

  it('distributes tokens correctly on any combination of bids', async function () {
    // stateful prob based tests can take a long time to finish when shrinking...
    this.timeout(GEN_TESTS_TIMEOUT * 1000);

    if (GEN_TESTS_QTY > 0) {
      let property = jsc.forall(crowdsaleTestInputGen, async function (crowdsaleAndCommands) {
        const result = await runGeneratedCrowdsaleAndCommands(crowdsaleAndCommands);
        return result;
      });

      console.log('Generative tests to run:', GEN_TESTS_QTY);
      return jsc.assert(property, { tests: GEN_TESTS_QTY });
    } else {
      console.log('Skipping property-based test (GEN_TESTS_QTY === 0)');
    }
  });
});
