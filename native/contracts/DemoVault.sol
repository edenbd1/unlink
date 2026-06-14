// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Minimal ERC-4626 vault for the Ledger × Unlink demo: deposit USDC, mint shares.
// Standard-compliant enough for client.execute's approve + deposit(assets, receiver).
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
}

contract DemoVault {
    IERC20 public immutable asset;
    string public name = "Unlink Demo Vault";
    string public symbol = "udUSDC";
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);

    constructor(address _asset) {
        asset = IERC20(_asset);
        decimals = IERC20(_asset).decimals();
    }

    function totalAssets() public view returns (uint256) { return asset.balanceOf(address(this)); }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply;
        return supply == 0 ? assets : assets * supply / totalAssets();
    }
    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply;
        return supply == 0 ? shares : shares * totalAssets() / supply;
    }
    function previewDeposit(uint256 assets) public view returns (uint256) { return convertToShares(assets); }
    function previewRedeem(uint256 shares) public view returns (uint256) { return convertToAssets(shares); }
    function maxDeposit(address) public pure returns (uint256) { return type(uint256).max; }
    function maxRedeem(address owner) public view returns (uint256) { return balanceOf[owner]; }

    function deposit(uint256 assets, address receiver) public returns (uint256 shares) {
        shares = previewDeposit(assets);
        require(asset.transferFrom(msg.sender, address(this), assets), "transferFrom failed");
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) public returns (uint256 assets) {
        if (msg.sender != owner) {
            uint256 a = allowance[owner][msg.sender];
            if (a != type(uint256).max) allowance[owner][msg.sender] = a - shares;
        }
        assets = convertToAssets(shares);
        _burn(owner, shares);
        require(asset.transfer(receiver, assets), "transfer failed");
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount; balanceOf[to] += amount; emit Transfer(address(0), to, amount);
    }
    function _burn(address from, uint256 amount) internal {
        balanceOf[from] -= amount; totalSupply -= amount; emit Transfer(from, address(0), amount);
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; emit Transfer(msg.sender, to, amount); return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount; balanceOf[to] += amount; emit Transfer(from, to, amount); return true;
    }
}
