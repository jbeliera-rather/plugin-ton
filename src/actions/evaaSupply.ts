import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
    ModelClass,
    generateObject,
    composeContext
} from "@elizaos/core";
import { sleep, convertToBigInt } from "../utils/util";
import BigNumber from "bignumber.js";
import { z } from "zod";
import evaaPkg from '@evaafi/sdk';
const {
    Evaa,
    FEES,
    TON_TESTNET,
    TESTNET_POOL_CONFIG,
    JUSDC_TESTNET,
    JUSDT_TESTNET,
    UserDataActive,
    AssetData,
    BalanceChangeType,
    calculatePresentValue,
    calculateCurrentRates,
    MasterConstants,
    AssetConfig,
    ExtendedAssetData,
    PoolAssetConfig,
    mulFactor,
    predictAPY,
    PricesCollector
}  = evaaPkg;

import { Cell, Dictionary, toNano, beginCell, storeMessage, internal, external, SendMode, Address } from '@ton/ton';
import {
    initWalletProvider,
    type WalletProvider,
    nativeWalletProvider,
} from "../providers/wallet";

export const supplySchema = z.object({
    amount: z.string(),
    asset: z.string().nullable().optional().transform(val => val === null ? "TON" : val),
    includeUserCode: z.boolean().nullable().optional().transform(val => val === null ? false : val),
    showInterest: z.boolean().nullable().optional().transform(val => val === null ? false : val),
});

export type SupplyContent = z.infer<typeof supplySchema>;


function isSupplyContent(content: any): content is SupplyContent {
    return (
        (typeof content.amount === "string" || typeof content.amount === "number") &&
        (content.asset === undefined || typeof content.asset === "string") &&
        (content.includeUserCode === undefined || typeof content.includeUserCode === "boolean") &&
        (content.showInterest === undefined || typeof content.showInterest === "boolean")
    );
}

const lendTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "amount": "1",
    "asset": "USDT" | "USDC" | "TON",
    "includeUserCode": true,
    "showInterest": true
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested lending operation:
- Amount to supply
- Asset to supply
- Whether to include user code (optional)
- Make sure to remove \`\`\`json and \`\`\` from the response

Respond with a JSON markdown block containing only the extracted values.`;

interface EvaaAsset {
    name: string;
    config: typeof AssetConfig;
    data: typeof ExtendedAssetData;
    asset: any;
}

export class SupplyAction {
    private walletProvider: WalletProvider;
    private evaa: typeof Evaa;
    private assetsData: Dictionary<bigint, typeof ExtendedAssetData>;
    private assetsConfig: Dictionary<bigint, typeof AssetConfig>;
    private masterConstants: typeof MasterConstants;
    private USDT: EvaaAsset;
    private USDC: EvaaAsset;
    private TON: EvaaAsset;
    private totalSupply: bigint;
    private totalBorrow: bigint;
    private collector: typeof PricesCollector;
    borrowInterest: bigint;
    predictAPY: bigint;
    withdrawalLimits: Dictionary<bigint, bigint>
    borrowLimits: Dictionary<bigint, bigint>

    constructor(walletProvider: WalletProvider) {
        this.walletProvider = walletProvider;
        this.evaa = null;
        this.assetsData = null;
        this.assetsConfig = null;
        this.masterConstants = null;
        this.USDT = null;
        this.USDC = null;
        this.TON = null;
        this.totalSupply = null;
        this.totalBorrow = null;
        this.borrowInterest = null;
        this.predictAPY = null;
        this.collector = null;

        this.withdrawalLimits = null;
        this.borrowLimits = null;
    }

    private async waitForPrincipalChange(addr: Address, asset: typeof PoolAssetConfig, func: any, currentEvaa = this.evaa, currentClient = this.walletProvider.getWalletClient()):Promise<{ principal: bigint, data: typeof UserDataActive }> {
        let prevPrincipal = 0n;
        let user = currentClient.open(await currentEvaa.openUserContract(addr));
        await user.getSync(currentEvaa.data!.assetsData, currentEvaa.data!.assetsConfig, (await this.collector.getPrices()).dict);

        if (user.data?.type == "active") {
            prevPrincipal = user.data.principals.get(asset.assetId) ?? 0n;
        }

        await new Promise( resolve => setTimeout(resolve, 1000) );

        await func();

        while (true) {
            user = currentClient.open(await currentEvaa.openUserContract(addr));
            await user.getSync(currentEvaa.data!.assetsData, currentEvaa.data!.assetsConfig, (await this.collector.getPrices()).dict);
            if (user.data?.type == "active") {
                const principalNow: bigint = user.data.principals.get(asset.assetId) ?? 0n;
                if (Math.abs(Number(principalNow - prevPrincipal)) > 10) {
                    return {principal: principalNow, data: user.data};
                }
            }
            await new Promise( resolve => setTimeout(resolve, 4000) );
        }
    }

    async supply(params: SupplyContent, runtime: IAgentRuntime, callback: HandlerCallback): Promise<any> {

            // Get wallet instance
            const walletClient = this.walletProvider.getWalletClient();
            const wallet = walletClient.open(this.walletProvider.wallet);
            const tonExplorerUrl = runtime.getSetting("TON_EXPLORER_URL") || "https://testnet.tonviewer.com/";


            // Initialize EVAA SDK
            this.evaa = walletClient.open(
                new Evaa({poolConfig: TESTNET_POOL_CONFIG}),
            );
            await this.evaa.getSync();

            this.assetsData = this.evaa.data?.assetsData!;
            this.assetsConfig = this.evaa.data?.assetsConfig!;
            this.masterConstants = this.evaa.poolConfig.masterConstants;

            this.USDT = {
                name: "USDT",
                data: this.assetsData.get(JUSDT_TESTNET.assetId)!,
                config: this.assetsConfig.get(JUSDT_TESTNET.assetId)!,
                asset: JUSDT_TESTNET
            }
            this.USDC = {
                name: "USDC",
                data: this.assetsData.get(JUSDC_TESTNET.assetId)!,
                config: this.assetsConfig.get(JUSDC_TESTNET.assetId)!,
                asset: JUSDC_TESTNET
            }
            this.TON = {
                name: "TON",
                data: this.assetsData.get(TON_TESTNET.assetId)!,
                config: this.assetsConfig.get(TON_TESTNET.assetId)!,
                asset: TON_TESTNET
            }

            this.totalSupply = calculatePresentValue(this.TON.data.sRate, this.TON.data.totalSupply, this.masterConstants);
            this.totalBorrow = calculatePresentValue(this.TON.data.bRate, this.TON.data.totalBorrow, this.masterConstants);
            // Calculate borrow interest
            this.borrowInterest = this.TON.config.baseBorrowRate +
            mulFactor(this.masterConstants.FACTOR_SCALE, this.TON.config.borrowRateSlopeLow, this.TON.config.targetUtilization) +
            mulFactor(
                this.masterConstants.FACTOR_SCALE,
                this.TON.config.borrowRateSlopeHigh,
                this.masterConstants.FACTOR_SCALE - this.TON.config.targetUtilization
            );

            // Calculate APY
            this.predictAPY = predictAPY({
                amount: this.totalBorrow,
                balanceChangeType: BalanceChangeType.Repay,
                assetData: this.TON.data,
                assetConfig: this.TON.config,
                masterConstants: this.masterConstants
            });

            // Initialize prices collector
            this.collector = new PricesCollector(TESTNET_POOL_CONFIG);

            // Get user instance
            const borrower = walletClient.open(this.evaa.openUserContract(wallet.address));
            // Fetch user data
            await borrower.getSync(this.evaa.data!.assetsData, this.evaa.data!.assetsConfig, (await this.collector.getPrices()).dict, true);

            // Check if the user has a active evaa contract
            const data = (borrower.data as typeof UserDataActive);
            elizaLogger.log('User data:', data.fullyParsed);

            if (borrower.data?.type != 'active') {
                elizaLogger.log('Borrower User is inactive');
                /*if (callback) {
                    callback({
                        text: `You need provide collateral funds before you can borrow`,
                        content: { error: "No collateral funds provided." }
                    });

                    return false;
                }*/
                // Calculate estimated interest
                const borrowAmount = typeof params.amount !== "string" ? new BigNumber(String(params.amount)) : new BigNumber(params.amount);
                const tonAsset = params.asset === "TON" ? this.TON : params.asset === "USDT" ? this.USDT : params.asset === "USDC" ? this.USDC : this.TON;
                if (!tonAsset) {
                    throw new Error("TON asset not found in master data");
                }

                // get supply message body
                const supplyMessage = this.evaa.createSupplyMessage({
                    queryID: 0n,
                    // we can set always to true, if we don't want to check user code version
                    includeUserCode: true,
                    amount: tonAsset.name === "TON" ? toNano(params.amount) : convertToBigInt(Number(params.amount)*1e6),
                    userAddress: wallet.address,
                    asset: tonAsset.asset,
                    payload: Cell.EMPTY,
                    amountToTransfer: toNano(0),
                });

                // create signed transfer for out wallet with internal message to EVAA Master Contract
                const signedSupplyMessage = wallet.createTransfer({
                    seqno: await wallet.getSeqno(),
                    secretKey: this.walletProvider.keypair.secretKey,
                    messages: [
                        internal({
                            to: this.evaa.address,
                            value: toNano(params.amount) + FEES.SUPPLY,
                            body: supplyMessage,
                        }),
                    ],
                    sendMode: SendMode.PAY_GAS_SEPARATELY,
                    timeout: Math.floor(Date.now() / 1000) + 60,
                });
                // send this message. send() method creates external and send it, so
                // we need to create external message manually for getting its hash
                await wallet.send(signedSupplyMessage);

                // create external message manually
                const externalSupplyMessage = beginCell()
                    .store(
                        storeMessage(
                            external({
                                to: wallet.address,
                                body: signedSupplyMessage,
                            }),
                        ),
                    )
                    .endCell();

                await this.evaa.getSync();
                /*try {
                    await this.waitForPrincipalChange(wallet.address, this.TON.asset, async () => {
                        elizaLogger.log("Waiting for principal change...");
                        await sleep(10000);
                        return true;
                    });
                } catch (error) {
                    elizaLogger.error(error);
                }*/
                await sleep(30000);

                // Get transaction hash and explorer URL
                const txHash = externalSupplyMessage.hash().toString('hex');
                const explorerUrl = `${tonExplorerUrl}/transaction/${txHash}`;

                //let amountToRepay = data.balances.get(tonAsset.asset.assetId)!.amount;
                //elizaLogger.debug('Amount to repay', amountToRepay.toString());

                return {
                    txHash: txHash,
                    explorerUrl: explorerUrl,
                    asset: tonAsset.name,
                    amount: borrowAmount.toString(),
                    amountToRepay: 0,
                    dailyInterest: 0,
                    annualInterestRate: 0
                };


            } else {

                this.withdrawalLimits = borrower.data.withdrawalLimits;
                this.borrowLimits = borrower.data.borrowLimits;
                elizaLogger.debug('User principals');
                elizaLogger.debug('Real Principals', borrower.data.realPrincipals);
                elizaLogger.debug('User Principal', borrower.data.principals);
                elizaLogger.debug('Get Prices For Withdraw [USDT]', (await this.collector.getPricesForWithdraw(borrower.data.realPrincipals, JUSDT_TESTNET)).dict);
                elizaLogger.debug('Get Prices For Withdraw [USDC]', (await this.collector.getPricesForWithdraw(borrower.data.realPrincipals, JUSDC_TESTNET)).dict);
                let amoundToRepayTON = data.balances.get(TON_TESTNET.assetId)!.amount;
                elizaLogger.debug('Amount to repay [TON]', new BigNumber(amoundToRepayTON).toFixed(4));
                let amoundToRepayUSDT = data.balances.get(JUSDT_TESTNET.assetId)!.amount;
                elizaLogger.debug('Amount to repay [USDT]', new BigNumber(amoundToRepayUSDT).toFixed(2));
                let amoundToRepayUSDC = data.balances.get(JUSDC_TESTNET.assetId)!.amount;
                elizaLogger.debug('Amount to repay [USDC]', new BigNumber(amoundToRepayUSDC).toFixed(2));

                // Calculate estimated interest
                const borrowAmount = typeof params.amount !== "string" ? new BigNumber(String(params.amount)) : new BigNumber(params.amount);
                const tonAsset = params.asset === "TON" ? this.TON : params.asset === "USDT" ? this.USDT : params.asset === "USDC" ? this.USDC : this.TON;
                if (!tonAsset) {
                    throw new Error("TON asset not found in master data");
                }
                elizaLogger.debug('Borrow amount', borrowAmount.toFixed(4));
                elizaLogger.debug('Borrow limits',this.borrowLimits);
                // Calculate estimated rates
                const assetRates = calculateCurrentRates(tonAsset.config, tonAsset.data, this.masterConstants);

                const { borrowInterest, bRate, now, sRate, supplyInterest } = assetRates;
                const ONE = 10n ** 13n;

                // Convert the raw annual supply rate into a human‑readable number.
                // For example, a stored 700000000000 becomes 700000000000 / 1e13 = 0.07 (i.e. 7% APY)
                const annualInterestRateReadable = Number(sRate) / Number(ONE);

                // Compute the daily rate by dividing the annual rate by 365
                const dailyInterestRateReadable = annualInterestRateReadable / 365;

                // If you want the “rate” still in fixed‑point (for further on‑chain calculations) you could do:
                const annualRateFP = sRate;              // already annual, fixed-point 13 decimals
                const dailyRateFP = sRate / 365n;           // integer division – be aware of rounding

                // To compute the daily interest on a given principal, first decide on the unit and scaling.
                // For example, if your principal is 10 “tokens” and token amounts are also represented
                // in 13 decimals, then:
                const principal = 10n * ONE;  // 10 tokens in fixed-point form

                // Daily interest (in fixed point) = principal * (daily rate) / ONE
                const dailyInterestFP = (principal * dailyRateFP) / ONE;

                // For display, convert the fixed-point numbers to floating point:
                function formatFixedPoint(x: bigint, decimals: number = 13): string {
                  // This converts the integer value to a string with the implied decimal point.
                  const factor = 10 ** decimals;
                  return (Number(x) / factor).toFixed(6);
                }

                // Debugging
                elizaLogger.debug("Borrow Interest" , borrowInterest.toString());
                elizaLogger.debug("Borrow Rate" , bRate.toString());
                elizaLogger.debug("Supply Interest" , supplyInterest.toString());
                elizaLogger.debug("Supply Rate", sRate.toString());
                elizaLogger.debug("Now" , now.toString());
                elizaLogger.debug("Annual Interest Rate: ", annualInterestRateReadable.toString()); // e.g. 0.07 for 7%
                elizaLogger.debug("Daily Interest Rate:  ", dailyInterestRateReadable.toString());  // e.g. ~0.0001918 (0.01918% per day)
                elizaLogger.debug("Daily Interest (on 10 tokens):", formatFixedPoint(dailyInterestFP));

                const annualInterestRate = annualInterestRateReadable;
                const dailyInterestRate = dailyInterestRateReadable;
                const dailyInterest = formatFixedPoint(dailyInterestFP);

                // Get price data
                const priceData = await this.collector.getPrices();

                // get supply message body
                const supplyMessage = this.evaa.createSupplyMessage({
                    queryID: 0n,
                    // we can set always to true, if we don't want to check user code version
                    includeUserCode: true,
                    amount: tonAsset.name === "TON" ? toNano(params.amount) : convertToBigInt(Number(params.amount)*1e6),
                    userAddress: wallet.address,
                    asset: tonAsset.asset,
                    payload: Cell.EMPTY,
                    amountToTransfer: toNano(0),
                });

                // create signed transfer for out wallet with internal message to EVAA Master Contract
                const signedSupplyMessage = wallet.createTransfer({
                    seqno: await wallet.getSeqno(),
                    secretKey: this.walletProvider.keypair.secretKey,
                    messages: [
                        internal({
                            to: this.evaa.address,
                            value: toNano(params.amount) + FEES.SUPPLY,
                            body: supplyMessage,
                        }),
                    ],
                    sendMode: SendMode.PAY_GAS_SEPARATELY,
                    timeout: Math.floor(Date.now() / 1000) + 60,
                });
                // send this message. send() method creates external and send it, so
                // we need to create external message manually for getting its hash
                await wallet.send(signedSupplyMessage);

                // create external message manually
                const externalSupplyMessage = beginCell()
                    .store(
                        storeMessage(
                            external({
                                to: wallet.address,
                                body: signedSupplyMessage,
                            }),
                        ),
                    )
                    .endCell();

                await this.evaa.getSync();
                /*try {
                    await this.waitForPrincipalChange(wallet.address, this.TON.asset, async () => {
                        elizaLogger.log("Waiting for principal change...");
                        await sleep(10000);
                        return true;
                    });
                } catch (error) {
                    elizaLogger.error(error);
                }*/
                await sleep(30000);

                // Get transaction hash and explorer URL
                const txHash = externalSupplyMessage.hash().toString('hex');
                const explorerUrl = `${tonExplorerUrl}/transaction/${txHash}`;

                let amountToRepay = data.balances.get(tonAsset.asset.assetId)!.amount;
                elizaLogger.debug('Amount to repay', amountToRepay.toString());

                return {
                    txHash: txHash,
                    explorerUrl: explorerUrl,
                    asset: tonAsset.name,
                    amount: borrowAmount.toString(),
                    amountToRepay: amountToRepay.toString(),
                    dailyInterest,
                    annualInterestRate
                };
            }

    }
}


const supplyAction: Action = {
    name: "EVAA_SUPPLY",
    similes: [
        "LEND",
        "LEND_TON",
        "SUPPLY_TON",
        "DEPOSIT_TON",
        "LEND_USDT",
        "SUPPLY_USDT",
        "DEPOSIT_USDT",
        "LEND_USDC",
        "SUPPLY_USDC",
        "DEPOSIT_USDC",
        "LEND_TONCOIN",
        "SUPPLY_TONCOIN"
    ],
    description: "Supply/lend TON, USDT and USDC tokens to the EVAA lending protocol",
    validate: async (runtime: IAgentRuntime) => {
        const walletProvider = await initWalletProvider(runtime);
        return !!walletProvider.getAddress();
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback?: HandlerCallback
    ) => {
        elizaLogger.info("Starting SUPPLY EVAA handler");

        try {
            // Compose context to extract lending parameters
            const supplyContext = composeContext({
                state,
                template: lendTemplate
            });

            const content = await generateObject({
                runtime,
                context: supplyContext,
                schema: supplySchema,
                modelClass: ModelClass.LARGE,
            });

            const supplyDetails = content.object as SupplyContent;
            elizaLogger.debug(`Supply details: ${JSON.stringify(content.object)}`);

            if (!isSupplyContent(supplyDetails)) {
                throw new Error("Invalid supplying parameters");
            }

            const walletProvider = await initWalletProvider(runtime);
            const action = new SupplyAction(walletProvider);
            const supplyResult = await action.supply(supplyDetails, runtime, callback);

            if (callback) {
                let responseText = `Successfully initiated supplying of ${supplyDetails.amount} ${supplyResult.asset}.`;

                // Add interest information if requested
                if (supplyDetails.showInterest) {
                    const formattedDailyInterest = Number(supplyResult.dailyInterest).toFixed(4);
                    const formattedAnnualRate = (Number(supplyResult.annualInterestRate) * 100).toFixed(2); //(supplyResult.annualInterestRate * 100).toFixed(2);
                    responseText += `\n\nEstimated Interest:\n- Daily Interest: ${formattedDailyInterest} ${supplyResult.asset}\n- Annual Interest Rate: ${formattedAnnualRate}%`;
                }

                responseText += `\n\nTrack the transaction here: ${supplyResult.explorerUrl}`;

                callback({
                    text: responseText,
                    metadata: {
                        txHash: supplyResult.txHash,
                        explorerUrl: supplyResult.explorerUrl,
                        asset: supplyResult.asset,
                        amount: supplyDetails.amount,
                        amountToRepay: supplyResult.amountToRepay,
                        dailyInterest: supplyResult.dailyInterest.toString(),
                        annualInterestRate: supplyResult.annualInterestRate.toString(),
                        action: "SUPPLY"
                    },
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error in LEND_TON handler:", error);
            if (callback) {
                callback({
                    text: `Failed to lend TON: ${error.message}`,
                    error: true,
                });
            }
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I want to supply 1 TON to the EVAA protocol",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I'll help you supply 1 TON to the EVAA protocol. Processing your request...",
                    action: "SUPPLY",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you lend 0.5 TON to EVAA with user code included?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I'll help you lend 0.5 TON to EVAA with user code included. Processing your request...",
                    action: "LEND",
                },
            },
        ],
    ],
};

export default supplyAction;
