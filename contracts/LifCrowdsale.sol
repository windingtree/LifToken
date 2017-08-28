pragma solidity ^0.4.13;

import "zeppelin-solidity/contracts/ownership/Ownable.sol";
import "zeppelin-solidity/contracts/lifecycle/Pausable.sol";
import "zeppelin-solidity/contracts/math/SafeMath.sol";
import "./LifToken.sol";
import "./LifMarketMaker.sol";

contract LifCrowdsale is Ownable, Pausable {
  using SafeMath for uint256;

  // The token being sold
  LifToken public token;

  // start and end of the public presale
  uint256 public publicPresaleStartBlock;
  uint256 public publicPresaleEndBlock;

  // start and end block where investments are allowed (both inclusive)
  uint256 public startBlock;
  uint256 public endBlock1;
  uint256 public endBlock2;

  // address where funds are collected
  address public foundationWallet;

  // minimun amount of wei to be raised in order to succed, it starts in USD
  uint256 public maxPresaleCapUSD = 1000000;

  // minimun amount of wei to be raised in order to succed, it starts in USD
  uint256 public minCapUSD = 5000000;

  // maximun balance that the foundation can have, it starts in USD
  uint256 public maxFoundationCapUSD = 10000000;

  // maximun balance that the 24 month market maker can have
  uint256 public marketMaker24PeriodsCapUSD = 40000000;

  // how much a USD worth in wei in public presale
  uint256 public weiPerUSDinPresale = 0;

  // how much a USD worth in wei in TGE
  uint256 public weiPerUSDinTGE = 0;

  // amount of blocks where the weiPerUSD cannot change before setWeiPerUSD functions
  uint256 public setWeiLockBlocks = 0;

  // how much wei a token unit costs to a buyer, during the private presale stage
  uint256 public privatePresaleRate;

  // how much wei a token unit costs to a buyer, during the public presale
  uint256 public publicPresaleRate;
  // how much wei a token unit costs to a buyer, during the first half of the crowdsale
  uint256 public rate1;
  // how much wei a token unit costs to a buyer, during the second half of the crowdsale
  uint256 public rate2;

  // amount of raised money in wei
  uint256 public weiRaised;

  // total amount of tokens sold on the TGE
  uint256 public tokensSold;

  // total amount of wei received as presale payments (both private and public)
  uint256 public totalPresaleWei;

  // the address of the market maker created at the end of the crowdsale
  address public marketMaker;

  mapping(address => uint256) public purchases;

  bool public isFinalized = false;

  event Finalized();

  /**
   * event for token purchase logging
   * @param purchaser who paid for the tokens
   * @param beneficiary who got the tokens
   * @param value weis paid for purchase
   * @param amount amount of tokens purchased
   */
  event TokenPurchase(
    address indexed purchaser,
    address indexed beneficiary,
    uint256 value,
    uint256 amount
  );

  function LifCrowdsale(
    uint256 _publicPresaleStartBlock,
    uint256 _publicPresaleEndBlock,
    uint256 _startBlock,
    uint256 _endBlock1,
    uint256 _endBlock2,
    uint256 _publicPresaleRate,
    uint256 _rate1,
    uint256 _rate2,
    uint256 _privatePresaleRate,
    uint256 _setWeiLockBlocks,
    address _foundationWallet
  ) {
    require(_publicPresaleStartBlock >= block.number);
    require(_publicPresaleEndBlock > _publicPresaleStartBlock);
    require(_startBlock > _publicPresaleEndBlock);
    require(_endBlock1 > _startBlock);
    require(_endBlock2 > _endBlock1);
    require(_publicPresaleRate > 0);
    require(_rate1 > 0);
    require(_rate2 > 0);
    require(_setWeiLockBlocks > 0);
    require(_foundationWallet != 0x0);

    token = new LifToken();
    token.pause();

    publicPresaleStartBlock = _publicPresaleStartBlock;
    publicPresaleEndBlock = _publicPresaleEndBlock;
    startBlock = _startBlock;
    endBlock1 = _endBlock1;
    endBlock2 = _endBlock2;
    publicPresaleRate = _publicPresaleRate;
    rate1 = _rate1;
    rate2 = _rate2;
    privatePresaleRate = _privatePresaleRate;
    setWeiLockBlocks = _setWeiLockBlocks;
    foundationWallet = _foundationWallet;
  }

  // Set how the rate wei per USD for the public presale, necesary to calculate with more
  // precision the maxCap on the presale.
  function setWeiPerUSDinPresale(uint256 _weiPerUSD) onlyOwner {
    require (block.number < publicPresaleStartBlock.sub(setWeiLockBlocks));
    weiPerUSDinPresale = _weiPerUSD;
  }

  // Set how the rate wei per USD for the TGE, necesary to calculate with more precision the
  // maxCap on the distribution of funds on finalize.
  function setWeiPerUSDinTGE(uint256 _weiPerUSD) onlyOwner {
    require (block.number < startBlock.sub(setWeiLockBlocks));
    weiPerUSDinTGE = _weiPerUSD;
  }

  // returns the current rate or 0 if current block is not within the crowdsale period
  function getRate() public constant returns (uint256) {
    if (block.number < publicPresaleStartBlock)
      return 0;
    else if (block.number <= publicPresaleEndBlock)
      return publicPresaleRate;
    else if (block.number < startBlock)
      return 0;
    else if (block.number <= endBlock1)
      return rate1;
    else if (block.number <= endBlock2)
      return rate2;
    else
      return 0;
  }

  // fallback function can be used to buy tokens
  function () payable {
    if (block.number >= startBlock)
      buyTokens(msg.sender);
    else
      buyPresaleTokens(msg.sender);
  }

  // low level token purchase function for TGE
  function buyTokens(address beneficiary) payable {
    require(beneficiary != 0x0);
    require(validPurchase());
    assert(weiPerUSDinTGE > 0);

    uint256 weiAmount = msg.value;

    // get current price (it depends on current block number)
    uint256 rate = getRate();

    assert(rate > 0);

    // calculate token amount to be created
    uint256 tokens = weiAmount.mul(rate);

    // store wei amount in case of TGE min cap not reached
    weiRaised = weiRaised.add(weiAmount);
    purchases[beneficiary] = weiAmount;
    tokensSold = tokensSold.add(tokens);

    token.mint(beneficiary, tokens);
    TokenPurchase(msg.sender, beneficiary, weiAmount, tokens);
  }

  // low level token purchase function for presale
  function buyPresaleTokens(address beneficiary) payable {
    require(beneficiary != 0x0);
    require(validPresalePurchase());
    assert(weiPerUSDinPresale > 0);

    uint256 weiAmount = msg.value;

    // get current price (it depends on current block number)
    uint256 rate = getRate();

    assert(rate > 0);

    // calculate token amount to be created
    uint256 tokens = weiAmount.mul(rate);

    // store how much wei did we receive in presale
    totalPresaleWei = totalPresaleWei.add(weiAmount);

    token.mint(beneficiary, tokens);
    TokenPurchase(msg.sender, beneficiary, weiAmount, tokens);
  }

  function addPrivatePresaleTokens(address beneficiary, uint256 weiSent) onlyOwner {
    require(block.number < publicPresaleStartBlock);
    require(beneficiary != address(0));
    require(weiSent > 0);

    uint256 tokens = weiSent.mul(privatePresaleRate);

    totalPresaleWei.add(weiSent);

    token.mint(beneficiary, tokens);
  }

  // send ether to the fund collection wallet
  function forwardFunds() internal {

    // calculate the max amount of wei for the foundation
    uint256 foundationBalanceCapWei = maxFoundationCapUSD.mul(weiPerUSDinTGE);

    // if the minimiun cap for the market maker is not reached transfer all funds to foundation
    // else if the min cap for the market maker is reached, create it and send the remaining funds
    if (this.balance < foundationBalanceCapWei) {

      foundationWallet.transfer(this.balance);

    } else {

      uint256 mmFundBalance = this.balance.sub(foundationBalanceCapWei);

      // check how much preiods we have to use on the market maker
      uint8 marketMakerPeriods = 24;
      if (mmFundBalance > marketMaker24PeriodsCapUSD.mul(weiPerUSDinTGE))
        marketMakerPeriods = 48;

      foundationWallet.transfer(foundationBalanceCapWei);

      // TODO: create the market maker with a start block that equals one month after crowdsale ends
      LifMarketMaker newMarketMaker = new LifMarketMaker(
        address(token), block.number.add(10), 20, marketMakerPeriods, foundationWallet, 105000
      );
      newMarketMaker.fund.value(mmFundBalance)();

      marketMaker = address(newMarketMaker);

    }
  }

  // @return true if the transaction can buy tokens on TGE
  function validPurchase() internal constant returns (bool) {
    uint256 current = block.number;
    bool withinPeriod = current >= startBlock && current <= endBlock2;
    bool nonZeroPurchase = msg.value != 0;
    return (withinPeriod && nonZeroPurchase);
  }

  // @return true if the transaction can buy tokens on presale
  function validPresalePurchase() internal constant returns (bool) {
    uint256 current = block.number;
    bool withinPublicPresalePeriod = current >= publicPresaleStartBlock && current <= publicPresaleEndBlock;
    bool maxPresaleNotReached = totalPresaleWei.add(msg.value) <= maxPresaleCapUSD.mul(weiPerUSDinPresale);
    bool nonZeroPurchase = msg.value != 0;
    return (withinPublicPresalePeriod && maxPresaleNotReached && nonZeroPurchase);
  }

  // @return true if crowdsale event has ended
  function hasEnded() public constant returns (bool) {
    return block.number > endBlock2;
  }

  function funded() public constant returns (bool) {
    assert(weiPerUSDinTGE > 0);
    return weiRaised >= minCapUSD.mul(weiPerUSDinTGE);
  }

  // return the eth if the crowdsale didnt reach the minCap
  function claimEth() public {
    require(isFinalized);
    require(hasEnded());
    require(!funded());

    uint256 toReturn = purchases[msg.sender];
    assert(toReturn > 0);

    purchases[msg.sender] = 0;

    msg.sender.transfer(toReturn);
  }

  // should be called after crowdsale ends, to do
  // some extra finalization work
  function finalize() public {
    require(!isFinalized);
    require(hasEnded());

    // TODO: transfer an extra 25% of tokens to the foundation, for the team
    // TODO: transfer 13% to founders with a vesting mechanism?

    // foward founds and unpause token only if minCap is reached
    if (funded()) {

      // finish the minting of the token, unpause it and transfer the ownership to the foundation
      token.finishMinting();
      token.unpause();
      token.transferOwnership(owner);

      forwardFunds();

    }

    Finalized();
    isFinalized = true;
  }

}
