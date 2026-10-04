// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/** Small local-only ERC-721 used to prove an owner-added Anvil collection path. */
contract LocalAnvilCollection {
    error NotHeld();
    error UnknownToken();

    uint256 private constant TOKEN_ID = 7;
    address private immutable _HOLDER;

    constructor() {
        _HOLDER = msg.sender;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd || interfaceId == 0x780e9d63;
    }

    function name() external pure returns (string memory) { return "Local Anvil Collection"; }
    function symbol() external pure returns (string memory) { return "LANV-NFT"; }
    function totalSupply() external pure returns (uint256) { return 1; }

    function balanceOf(address owner) external view returns (uint256) {
        return owner == _HOLDER ? 1 : 0;
    }

    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256) {
        if (owner != _HOLDER || index != 0) revert NotHeld();
        return TOKEN_ID;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        if (tokenId != TOKEN_ID) revert UnknownToken();
        return _HOLDER;
    }

    function tokenURI(uint256 tokenId) external pure returns (string memory) {
        if (tokenId != TOKEN_ID) revert UnknownToken();
        return "data:application/json,{\"name\":\"Local Anvil #7\"}";
    }
}
