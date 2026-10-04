// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/** Small local-only ERC-20 used to prove an owner-added Anvil asset path. */
contract LocalAnvilToken {
    mapping(address => uint256) public balanceOf;

    constructor() {
        balanceOf[msg.sender] = 1_234_000_000;
    }

    function name() external pure returns (string memory) { return "Local Anvil Token"; }
    function symbol() external pure returns (string memory) { return "LANV"; }
    function decimals() external pure returns (uint8) { return 6; }
}
