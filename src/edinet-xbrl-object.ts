import { EdinetDataUtil } from "./edinet-data-util";
import { EdinetContext } from "./edinet-context";
import { JppfsCorTaxonomy } from "./types/jppfs_cor_taxonomy";
import { cleanHtml } from "./utils/html-cleaner";

/**
 * 共通メタデータ
 * 全ての書類に含まれるメタデータ
 */
export interface CommonMetadata {
    /** 書類管理ID */
    docID: string;
    /** 提出者名 */
    filerName: string;
    /** 提出者のEDINETコード */
    edinetCode: string;
    /** 書類名/件名 */
    docDescription: string;
    /** 提出日 */
    submitDate: string;
}

export class EdinetData {
    constructor(
        public readonly key: string,
        public readonly value: string,
        public readonly decimals: number = 0,
        public readonly unitRef: string = "",
        public readonly contextRef: string = ""
    ) { }

    /**
     * XMLノードから `EdinetData` インスタンスを作成するファクトリメソッド。
     * @param node パース済みのXMLノード
     * @param key XBRLタグ名 (例: "jpcrp_cor:NetSales")
     */
    public static create(node: unknown, key: string): EdinetData {
        const value = EdinetDataUtil.getValue(node);
        const decimals = EdinetDataUtil.getDecimals(node);
        const unitRef = EdinetDataUtil.getUnitRef(node);
        const contextRef = EdinetDataUtil.getContextRef(node);

        return new EdinetData(key, value, decimals, unitRef, contextRef);
    }
}

export class EdinetXbrlObject {
    private _dataMap: Map<string, EdinetData[]> = new Map();
    private contextMap: Map<string, EdinetContext> = new Map();
    private _docID: string;

    constructor(docID: string = "") {
        this._docID = docID;
    }

    /**
     * 保持しているデータを全てクリアします。
     */
    public clear(): void {
        this._dataMap.clear();
        this.contextMap.clear();
        this._docID = "";
    }

    /**
     * コンテキスト定義を追加します。
     */
    public addContext(context: EdinetContext): void {
        this.contextMap.set(context.id, context);
    }

    /**
     * 指定されたキーのデータを追加します。同じキーに複数のデータ（期間違いなど）が存在し得ます。
     */
    public put(key: string, edinetData: EdinetData): void {
        const existing = this._dataMap.get(key) || [];
        existing.push(edinetData);
        this._dataMap.set(key, existing);
    }

    /**
     * 指定されたキーに関連するすべてのデータリストを取得します。
     */
    public getDataList(key: string): EdinetData[] {
        return this._dataMap.get(key) || [];
    }

    /**
     * 名前空間に依存せず、タグ名で検索してデータリストを取得します。
     * 例: "BusinessRisksTextBlock" で検索すると、
     * "jpcrp_cor:BusinessRisksTextBlock" または "jpcrp040300-q2r_E39268-000:BusinessRisksTextBlock"
     * などのキーに一致します。
     * 
     * @param tagName タグ名（名前空間なし）
     * @returns マッチするすべてのデータの配列
     */
    public getDataListByTagName(tagName: string): EdinetData[] {
        const results: EdinetData[] = [];
        for (const [key, dataList] of this._dataMap) {
            // キーから名前空間を除去してタグ名を抽出
            // lastIndexOf を使用して、複数のコロンを含むキーにも対応
            const keyTagName = key.includes(":") ? key.substring(key.lastIndexOf(":") + 1) : key;
            if (keyTagName === tagName) {
                results.push(...dataList);
            }
        }
        return results;
    }

    /**
     * 指定されたキーとコンテキストIDに対応するデータを取得します。
     */
    public getDataByContextRef(key: string, contextRef: string): EdinetData | null {
        const list = this.getDataList(key);
        return list.find((d) => d.contextRef === contextRef) || null;
    }

    public getKeys(): string[] {
        return Array.from(this._dataMap.keys());
    }

    public hasKey(key: string): boolean {
        return this._dataMap.has(key);
    }

    /**
     * 内部データマップへの読み取り専用アクセスを提供します。
     * XBRLファイルからパースされた全てのデータ要素を含むMapを返します。
     * 
     * 注意: このプロパティは下位互換性のために公開されていますが、
     * データの取得には getDataList(), getDataByContextRef(), getKeyMetrics() などの
     * 専用メソッドの使用を推奨します。
     * 
     * @returns キー（タグ名）から EdinetData の配列へのマッピング
     */
    public get dataMap(): ReadonlyMap<string, readonly EdinetData[]> {
        return this._dataMap;
    }

    /**
   * 主要な経営指標を抽出します。
   * コンテキスト（連結/単体、期間）を自動的に解析し、最適なデータを検索します。
   */
    public getKeyMetrics(): KeyMetrics {
        // 戦略: まず連結(Consolidated)を探し、なければ単体(NonConsolidated)を探します。
        // 日付が新しい順にソートされた全コンテキストを使用します。
        // これにより、最新のコンテキスト（提出日など）にデータがなく、その次（当期）にある場合でも取得できます。

        // 過去年度のデータを誤って取得しないよう、最新の日付から半年以内のデータに限定します。
        const filterRecent = (ctxs: EdinetContext[]) => {
            if (ctxs.length === 0) return [];
            const latest = ctxs[0].period.endDate || ctxs[0].period.instant || "";
            if (!latest) return ctxs;

            const latestTime = new Date(latest).getTime();
            const threshold = 180 * 24 * 60 * 60 * 1000; // 180 days

            return ctxs.filter(c => {
                const current = c.period.endDate || c.period.instant || "";
                if (!current) return false;
                return (latestTime - new Date(current).getTime()) < threshold;
            });
        }

        // 連結グループと単体グループを分けて保持します。
        // 連結コンテキストが実在する場合はそのグループ内だけで全タグを試し、
        // 見つからなければ（単体にフォールバックせず）undefinedとします。
        // 連結コンテキストが1件も無い企業の場合のみ、単体グループにフォールバックします。
        // これにより、連結コンテキストは存在するのに対象タグが無いIFRS企業などで、
        // 単体側にたまたま存在する値を誤って返してしまうことを防ぎます（issue #7）。
        const durationGroups = [
            filterRecent(this.findContexts({ type: "Duration", scope: "Consolidated" })).map(c => c.id),
            filterRecent(this.findContexts({ type: "Duration", scope: "NonConsolidated" })).map(c => c.id)
        ];
        // レガシー/ハードコードされたIDへのフォールバック（実コンテキストが1件も見つからない場合の最終手段）
        const durationLegacyIds = ["CurrentYearDuration", "CurrentYearDuration_NonConsolidatedMember"];

        const instantGroups = [
            filterRecent(this.findContexts({ type: "Instant", scope: "Consolidated" })).map(c => c.id),
            filterRecent(this.findContexts({ type: "Instant", scope: "NonConsolidated" })).map(c => c.id)
        ];
        const instantLegacyIds = ["CurrentYearInstant", "CurrentYearInstant_NonConsolidatedMember"];

        const durationIds: [string[][], string[]] = [durationGroups, durationLegacyIds];
        const instantIds: [string[][], string[]] = [instantGroups, instantLegacyIds];

        // 1株当たり指標・発行済株式数・配当・比率系は、決算短信様式の慣習上、
        // 連結決算を提出している企業でも値そのものが単体(NonConsolidatedMember)コンテキストにのみ
        // 記載されることが多いため、上記の厳格な連結優先探索は適用せず、
        // 従来通り連結→単体の順にフラットに探索します（単体でも見つかった値を採用）。
        const durationIdsFlat = [...durationGroups[0], ...durationGroups[1], ...durationLegacyIds];
        const instantIdsFlat = [...instantGroups[0], ...instantGroups[1], ...instantLegacyIds];

        return {
            netSales: this.getNumberValue(["jppfs_cor:NetSales", "jpcrp_cor:NetSales", "jpcrp_cor:RevenueIFRSSummaryOfBusinessResults"], durationIds),
            operatingIncome: this.getNumberValue(["jppfs_cor:OperatingIncome", "jpcrp_cor:OperatingIncomeIFRSSummaryOfBusinessResults"], durationIds), // Note: OperatingIncome might be company-specific in IFRS
            ordinaryIncome: this.getNumberValue(["jppfs_cor:OrdinaryIncome"], durationIds), // IFRS doesn't usually have OrdinaryIncome
            netIncome: this.getNumberValue(["jppfs_cor:ProfitLossAttributableToOwnersOfParent", "jpcrp_cor:ProfitLossAttributableToOwnersOfParentIFRSSummaryOfBusinessResults"], durationIds),
            netAssets: this.getNumberValue(["jppfs_cor:NetAssets", "jpcrp_cor:EquityAttributableToOwnersOfParentIFRSSummaryOfBusinessResults"], instantIds),
            totalAssets: this.getNumberValue(["jppfs_cor:Assets", "jpcrp_cor:TotalAssetsIFRSSummaryOfBusinessResults"], instantIds),

            // Cash Flows
            operatingCashFlow: this.getNumberValue(["jppfs_cor:NetCashProvidedByUsedInOperatingActivities", "jpcrp_cor:NetCashProvidedByUsedInOperatingActivitiesSummaryOfBusinessResults", "jpcrp_cor:CashFlowsFromUsedInOperatingActivitiesIFRSSummaryOfBusinessResults"], durationIds),
            investingCashFlow: this.getNumberValue(["jppfs_cor:NetCashProvidedByUsedInInvestmentActivities", "jppfs_cor:NetCashProvidedByUsedInInvestingActivities", "jpcrp_cor:NetCashProvidedByUsedInInvestingActivitiesSummaryOfBusinessResults", "jpcrp_cor:CashFlowsFromUsedInInvestingActivitiesIFRSSummaryOfBusinessResults"], durationIds),
            financingCashFlow: this.getNumberValue(["jppfs_cor:NetCashProvidedByUsedInFinancingActivities", "jpcrp_cor:NetCashProvidedByUsedInFinancingActivitiesSummaryOfBusinessResults", "jpcrp_cor:CashFlowsFromUsedInFinancingActivitiesIFRSSummaryOfBusinessResults"], durationIds),
            cashAndEquivalents: this.getNumberValue(["jppfs_cor:CashAndCashEquivalents", "jppfs_cor:CashAndCashEquivalentsEndOfPeriod", "jpcrp_cor:CashAndCashEquivalentsIFRSSummaryOfBusinessResults"], instantIds),

            // Per Share（決算短信様式の慣習上、単体コンテキストにのみ記載されることが多いためフラット探索）
            earningsPerShare: this.getNumberValueFlat(["jppfs_cor:BasicEarningsLossPerShare", "jpcrp_cor:BasicEarningsLossPerShareSummaryOfBusinessResults", "jpcrp_cor:BasicEarningsLossPerShareIFRSSummaryOfBusinessResults"], durationIdsFlat),
            bookValuePerShare: this.getNumberValueFlat(["jppfs_cor:NetAssetsPerShare", "jpcrp_cor:NetAssetsPerShareSummaryOfBusinessResults", "jpcrp_cor:EquityAttributableToOwnersOfParentPerShareIFRSSummaryOfBusinessResults"], instantIdsFlat),

            // Ratios & Types（同上）
            equityToTotalAssetsRatio: this.getNumberValueFlat(["jpcrp_cor:EquityToAssetRatioSummaryOfBusinessResults", "jpcrp_cor:EquityToTotalAssetsRatioSummaryOfBusinessResults", "jppfs_cor:EquityToTotalAssetsRatio", "jpcrp_cor:RatioOfOwnersEquityToGrossAssetsIFRSSummaryOfBusinessResults"], instantIdsFlat),
            rateOfReturnOnEquity: this.getNumberValueFlat(["jpcrp_cor:RateOfReturnOnEquitySummaryOfBusinessResults", "jpcrp_cor:RateOfReturnOnEquityIFRSSummaryOfBusinessResults", "jppfs_cor:RateOfReturnOnEquity"], durationIdsFlat),
            priceEarningsRatio: this.getNumberValueFlat(["jpcrp_cor:PriceEarningsRatioSummaryOfBusinessResults", "jpcrp_cor:PriceEarningsRatioIFRSSummaryOfBusinessResults"], durationIdsFlat), // Less common in XBRL
            payoutRatio: this.getNumberValueFlat(["jpcrp_cor:PayoutRatioSummaryOfBusinessResults", "jpcrp_cor:PayoutRatioIFRSSummaryOfBusinessResults"], durationIdsFlat),

            // Shares（同上）
            numberOfIssuedShares: this.getNumberValueFlat(["jpcrp_cor:TotalNumberOfIssuedSharesSummaryOfBusinessResults", "jppfs_cor:TotalNumberOfIssuedShares"], instantIdsFlat),
            dividendPaidPerShare: this.getNumberValueFlat(["jpcrp_cor:DividendPaidPerShareSummaryOfBusinessResults"], durationIdsFlat)
        };
    }

    /**
   * 論理的な条件を指定してデータを取得します。
   * コンテキストIDを意識せずにデータを取得するための推奨メソッドです。
   */
    public getData(key: string, options: {
        year?: "Current" | "Prior1Year" | "Prior2Year",
        type: "Duration" | "Instant",
        scope: "Consolidated" | "NonConsolidated"
    }): EdinetData | undefined {
        const context = this.findContext(options);
        if (!context) return undefined;
        return this.getDataByContextRef(key, context.id) || undefined;
    }

    /**
     * 条件に合致するコンテキストIDを検索します。
     * ロジック:
     * 1. 範囲(Scope)でフィルタ
     * 2. タイプ(Duration/Instant)でフィルタ
     * 3. 年度("Year")でオフセット指定 (0=最新, 1=前年...)
     */
    public findContext(options: {
        year?: "Current" | "Prior1Year" | "Prior2Year",
        type: "Duration" | "Instant",
        scope: "Consolidated" | "NonConsolidated"
    }): EdinetContext | undefined {
        const candidates = this.findContexts(options);
        return candidates[0];
    }

    /**
     * 条件に合致するすべてのコンテキストIDを、日付の新しい順に検索します。
     */
    public findContexts(options: {
        year?: "Current" | "Prior1Year" | "Prior2Year",
        type: "Duration" | "Instant",
        scope: "Consolidated" | "NonConsolidated"
    }): EdinetContext[] {
        let candidates = Array.from(this.contextMap.values()).filter(c => c.scope === options.scope);

        // 次元の厳密なチェック
        // 連結: 次元なし
        // 単体: "NonConsolidatedMember" のみを次元として持つ
        if (options.scope === "Consolidated") {
            candidates = candidates.filter(c => c.dimensions.length === 0);
        } else {
            candidates = candidates.filter(c => c.dimensions.length === 1 && c.dimensions[0] === "NonConsolidatedMember");
        }

        // タイプでフィルタ
        if (options.type === "Duration") {
            candidates = candidates.filter(c => c.period.startDate && c.period.endDate);
            // endDateの降順（最新優先）
            candidates.sort((a, b) => (b.period.endDate || "").localeCompare(a.period.endDate || ""));
        } else {
            candidates = candidates.filter(c => c.period.instant);
            // instantの降順（最新優先）
            candidates.sort((a, b) => (b.period.instant || "").localeCompare(a.period.instant || ""));
        }

        // 年度のオフセット処理
        // Current (default) = Index 0
        // Prior1Year = Index 1
        // Prior2Year = Index 2
        const offset = options.year === "Prior1Year" ? 1 :
            options.year === "Prior2Year" ? 2 : 0;

        // オフセット以降の候補を返す
        return candidates.slice(offset);
    }

    /**
     * コンテキストIDのグループ（例: [連結コンテキスト群, 単体コンテキスト群]）を順に探索します。
     *
     * 実在するコンテキストを持つ最初のグループが見つかった時点で、そのグループ内の
     * 全コンテキスト×全タグを試し尽くし、そこで探索を打ち切ります（見つからなければundefined）。
     * これにより、例えば連結コンテキストは存在するのに対象タグが無いIFRS企業などで、
     * 単体側にたまたま存在する値を誤って返してしまうことを防ぎます（issue #7）。
     *
     * どのグループにも実コンテキストが無い場合のみ、レガシー/ハードコードされたID
     * （`legacyContextRefs`）を最終手段として試します。
     */
    private getNumberValue(keys: string[], [contextGroups, legacyContextRefs]: [string[][], string[]]): number | undefined {
        for (const group of contextGroups) {
            if (group.length === 0) continue;
            return this.getNumberValueFlat(keys, group);
        }

        return this.getNumberValueFlat(keys, legacyContextRefs);
    }

    /**
     * コンテキストIDのフラットなリストを先頭から順に探索し、
     * 各コンテキストで全タグ候補を試します（従来からの探索方式）。
     *
     * 1株当たり指標・発行済株式数・配当・比率系など、決算短信様式の慣習上、
     * 連結決算を提出している企業でも値そのものが単体コンテキストにのみ記載される
     * 指標に使用します。連結を優先しつつ、見つからなければ単体の値も採用します。
     */
    private getNumberValueFlat(keys: string[], contextRefs: string[]): number | undefined {
        for (const contextRef of contextRefs) {
            for (const key of keys) {
                const data = this.getDataByContextRef(key, contextRef);
                if (data && data.value) {
                    const parsed = parseFloat(data.value);
                    if (!isNaN(parsed)) return parsed;
                }
            }
        }
        return undefined;
    }

    /**
     * 定性的なテキスト情報を抽出します。
     * （例：事業等のリスク、経営者による分析など）
     * HTMLタグとエスケープされたHTML実体は自動的に除去されます。
     */
    public getQualitativeInfo(): QualitativeInfo {
        // テキスト情報は通常、FilingDateInstant などの特定のコンテキストに紐付いていますが、
        // 書類全体で一意であることが多いため、ここではコンテキストを厳密に指定せず、
        // 存在するデータの中から最初に見つかった妥当な値を返します。

        const getString = (tagNames: string[]): string | undefined => {
            for (const tagName of tagNames) {
                // まず完全なキー（jpcrp_cor:タグ名）で検索
                // これにより標準名前空間が優先されます
                const fullKey = `jpcrp_cor:${tagName}`;
                let dataList = this.getDataList(fullKey);
                
                // 見つからない場合は、名前空間に依存しない検索（四半期・半期報告書対応）
                // 複数の名前空間でマッチする場合は最初のものを返しますが、
                // 通常、同じタグ名は同じ意味を持つため問題ありません
                if (dataList.length === 0) {
                    dataList = this.getDataListByTagName(tagName);
                }
                
                if (dataList.length > 0) {
                    // データが見つかれば、最初のものの値を返す（HTMLタグを除去）
                    return cleanHtml(dataList[0].value);
                }
            }
            return undefined;
        }

        return {
            businessPolicy: getString(["BusinessPolicyBusinessEnvironmentIssuesToAddressEtcTextBlock", "DescriptionOfBusinessPolicyEnvironmentAndIssuesToAddressTextBlock"]),
            businessRisks: getString(["BusinessRisksTextBlock"]),
            financialAnalysis: getString(["AnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock", "ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock"]),
            businessDescription: getString(["DescriptionOfBusinessTextBlock"]),
            companyHistory: getString(["CompanyHistoryTextBlock"]),
            researchAndDevelopment: getString(["ResearchAndDevelopmentActivitiesTextBlock"]),
            corporateGovernance: getString(["ExplanationAboutCorporateGovernanceTextBlock", "CorporateGovernanceTextBlock"]),
            operationsOverview: getString(["OverviewOfBusinessResultsTextBlock", "OverviewOfResultsOfOperationsEtcTextBlock"]),
            capitalResourcesAnalysis: getString(["CapitalResourcesAndLiquidityAnalysisTextBlock"]),
            criticalContracts: getString(["CriticalContractsForOperationTextBlock"]),
            employeesInformation: getString(["InformationAboutEmployeesTextBlock", "EmployeesInformationTextBlock"])
        };
    }

    /**
     * 財務諸表本表タクソノミ (jppfs_cor) のデータを型安全に取得するためのプロキシを返します。
     * プロパティにアクセスすると、自動的に最適なコンテキスト（連結優先、最新年度）のデータを検索して返します。
     * 
     * @returns JppfsCorTaxonomy インターフェースに準拠したプロキシオブジェクト
     */
    public getJppfsCor(): import("./types/jppfs_cor_taxonomy").JppfsCorTaxonomy {
        const _this = this;

        // パフォーマンス向上のためにコンテキストをキャッシュします
        // 遅延読み込み: getJppfsCorが呼び出されたタイミングでのみ計算されます
        // EdinetXbrlObjectはパース後通常不変であるため、キャッシュしても安全です
        const contexts = [
            ..._this.findContexts({ type: "Duration", scope: "Consolidated" }),
            ..._this.findContexts({ type: "Instant", scope: "Consolidated" }),
            ..._this.findContexts({ type: "Duration", scope: "NonConsolidated" }),
            ..._this.findContexts({ type: "Instant", scope: "NonConsolidated" })
        ];

        // プロキシ内部で `contexts` 配列を再利用することで最適化を行っています。
        // 以前はプロパティアクセスのたびに `findContexts`（Mapのフィルタリングを含む）を4回呼び出していましたが、
        // これによりオーバーヘッドを削減しています。

        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        return new Proxy({} as import("./types/jppfs_cor_taxonomy").JppfsCorTaxonomy, {
            get(target, prop, receiver) {
                if (typeof prop !== "string") return Reflect.get(target, prop, receiver);

                // namespace prefix "jppfs_cor:" を付与して検索
                const key = `jppfs_cor:${prop}`;

                // まず標準の名前空間で検索
                for (const context of contexts) {
                    const data = _this.getDataByContextRef(key, context.id);
                    if (data && data.value) {
                        const parsed = parseFloat(data.value);
                        return isNaN(parsed) ? data.value : parsed;
                    }
                }
                
                // 標準の名前空間で見つからない場合のみ、名前空間に依存しない検索（四半期・半期報告書対応）
                for (const context of contexts) {
                    const dataList = _this.getDataListByTagName(prop);
                    const data = dataList.find(d => d.contextRef === context.id);
                    if (data && data.value) {
                        const parsed = parseFloat(data.value);
                        return isNaN(parsed) ? data.value : parsed;
                    }
                }

                return undefined;
            }
        });
    }
    /**
     * 企業情報本表タクソノミ (jpcrp_cor) のデータを型安全に取得するためのプロキシを返します。
     * プロパティにアクセスすると、自動的に最適なコンテキスト（連結優先、最新年度）のデータを検索して返します。
     * 
     * @returns JpcrpCorTaxonomy インターフェースに準拠したプロキシオブジェクト
     */
    public getJpcrpCor(): import("./types/jpcrp_cor_taxonomy").JpcrpCorTaxonomy {
        const _this = this;

        // パフォーマンス向上のためにコンテキストをキャッシュします
        const contexts = [
            ..._this.findContexts({ type: "Duration", scope: "Consolidated" }),
            ..._this.findContexts({ type: "Instant", scope: "Consolidated" }),
            ..._this.findContexts({ type: "Duration", scope: "NonConsolidated" }),
            ..._this.findContexts({ type: "Instant", scope: "NonConsolidated" })
        ];

        return new Proxy({} as import("./types/jpcrp_cor_taxonomy").JpcrpCorTaxonomy, {
            get(target, prop, receiver) {
                if (typeof prop !== "string") return Reflect.get(target, prop, receiver);

                // namespace prefix "jpcrp_cor:" を付与して検索
                const key = `jpcrp_cor:${prop}`;

                // まず標準の名前空間で検索
                for (const context of contexts) {
                    const data = _this.getDataByContextRef(key, context.id);
                    if (data && data.value) {
                        const parsed = parseFloat(data.value);
                        return isNaN(parsed) ? data.value : parsed;
                    }
                }
                
                // 標準の名前空間で見つからない場合のみ、名前空間に依存しない検索（四半期・半期報告書対応）
                for (const context of contexts) {
                    const dataList = _this.getDataListByTagName(prop);
                    const data = dataList.find(d => d.contextRef === context.id);
                    if (data && data.value) {
                        const parsed = parseFloat(data.value);
                        return isNaN(parsed) ? data.value : parsed;
                    }
                }

                return undefined;
            }
        });
    }

    /**
     * 大量保有報告書（変更報告書、訂正報告書を含む）から主要な情報を抽出します。
     * ネームスペースは `jplvh_cor` を使用します。
     */
    public getLargeShareholdingInfo(): LargeShareholdingInfo {
        // ヘルパー: コンテキストを問わず、最初に見つかった値を返す
        const getVal = (key: string): string | undefined => {
            const list = this.getDataList(key);
            return list.length > 0 ? list[0].value : undefined;
        };

        const getNum = (key: string): number | undefined => {
            const val = getVal(key);
            return val ? parseFloat(val) : undefined;
        };

        return {
            filerName: getVal("jplvh_cor:FilerNameInJapaneseDEI") || getVal("jpdei_cor:FilerNameInJapaneseDEI") || getVal("jplvh_cor:Name"),
            issuerName: getVal("jplvh_cor:NameOfIssuer") || getVal("jplvh_cor:IssuerName"),
            holdingRatio: getNum("jplvh_cor:HoldingRatioOfShareCertificatesEtc"),
            prevHoldingRatio: getNum("jplvh_cor:HoldingRatioOfShareCertificatesEtcPerLastReport"),
            // Count can be inferred or found in tags like "NumberOfJointHolders"
            // For now, leaving it undefined as it requires counting members or finding specific tag
        };
    }

    /**
     * 書類の共通メタデータを取得します。
     * docIDはパーサー経由で渡された場合のみ値が入ります。
     */
    public getCommonMetadata(): CommonMetadata {
        const getVal = (key: string): string | undefined => {
            const list = this.getDataList(key);
            return list.length > 0 ? list[0].value : undefined;
        };

        return {
            docID: this._docID,
            filerName: getVal("jpdei_cor:FilerNameInJapaneseDEI") || "",
            edinetCode: getVal("jpdei_cor:EDINETCodeDEI") || "",
            docDescription: getVal("jpcrp_cor:DocumentTitleCoverPage") || "",
            submitDate: getVal("jpdei_cor:FilingDateCoverPage") || getVal("jpcrp_cor:FilingDateCoverPage") || ""
        };
    }

    /**
     * 大株主の状況を取得します。
     * 構造化されたデータとして返します。
     */
    public getMajorShareholders(): ShareholderInfo[] {
        const shareholders: ShareholderInfo[] = [];
        
        // MajorShareholdersMember を含むコンテキストを検索
        const contexts = Array.from(this.contextMap.values()).filter(c => 
            c.dimensions.some(d => d.endsWith("MajorShareholdersMember"))
        );

        for (const context of contexts) {
            const name = this.getDataByContextRef("jpcrp_cor:NameMajorShareholders", context.id)?.value;
            if (!name) continue;

            const numberOfSharesStr = this.getDataByContextRef("jpcrp_cor:NumberOfSharesHeld", context.id)?.value;
            const ownershipRatioStr = this.getDataByContextRef("jpcrp_cor:ShareholdingRatio", context.id)?.value;

            shareholders.push({
                name: name,
                numberOfShares: numberOfSharesStr ? parseFloat(numberOfSharesStr) : undefined,
                ownershipRatio: ownershipRatioStr ? parseFloat(ownershipRatioStr) : undefined
            });
        }

        return shareholders;
    }
}

/**
 * 財務・業績の主要指標
 */
export interface KeyMetrics {
    /** 売上高 */
    netSales?: number;
    /** 営業利益 */
    operatingIncome?: number;
    /** 経常利益 */
    ordinaryIncome?: number;
    /** 当期純利益 (親会社株主に帰属する当期純利益) */
    netIncome?: number;
    /** 純資産 */
    netAssets?: number;
    /** 総資産 */
    totalAssets?: number;

    // Cash Flows
    /** 営業活動によるキャッシュ・フロー */
    operatingCashFlow?: number;
    /** 投資活動によるキャッシュ・フロー */
    investingCashFlow?: number;
    /** 財務活動によるキャッシュ・フロー */
    financingCashFlow?: number;
    /** 現金及び現金同等物の期末残高 */
    cashAndEquivalents?: number;

    // Per Share
    /** EPS (1株当たり当期純利益) */
    earningsPerShare?: number;
    /** BPS (1株当たり純資産) */
    bookValuePerShare?: number;

    // Ratios & Others
    /** 自己資本比率 (例: 0.5 = 50%) */
    equityToTotalAssetsRatio?: number;
    /** ROE (自己資本利益率) (例: 0.1 = 10%) */
    rateOfReturnOnEquity?: number;
    /** PER (株価収益率) ※XBRLに含まれる場合のみ */
    priceEarningsRatio?: number;
    /** 配当性向 */
    payoutRatio?: number;
    /** 発行済株式総数 */
    numberOfIssuedShares?: number;
    /** 1株当たり配当額 */
    dividendPaidPerShare?: number;
}

/**
 * 大量保有報告書の情報
 */
export interface LargeShareholdingInfo {
    /** 提出者名 (氏名又は名称) */
    filerName?: string;
    /** 発行者名 (氏名又は名称) */
    issuerName?: string;
    /** 保有割合 (%) */
    holdingRatio?: number;
    /** 直前報告書における保有割合 (%) */
    prevHoldingRatio?: number;
    /** 共同保有者の数 */
    jointHoldersCount?: number;
}

/**
 * 定性的情報（テキスト）
 */
export interface QualitativeInfo {
    /** 事業の方針、事業環境及び対処すべき課題 */
    businessPolicy?: string;
    /** 事業等のリスク */
    businessRisks?: string;
    /** 経営者による財政状態、経営成績及びキャッシュ・フローの状況の分析 */
    financialAnalysis?: string;
    /** 事業の内容 */
    businessDescription?: string;
    /** 沿革 */
    companyHistory?: string;
    /** 研究開発活動 */
    researchAndDevelopment?: string;
    /** コーポレート・ガバナンスの状況等 */
    corporateGovernance?: string;
    /** 業績等の概要 */
    operationsOverview?: string;
    /** 資本の財源及び資金の流動性 */
    capitalResourcesAnalysis?: string;
    /** 経営上の重要な契約等 */
    criticalContracts?: string;
    /** 従業員の状況 */
    employeesInformation?: string;
}

/**
 * 株主情報
 */
export interface ShareholderInfo {
    /** 氏名又は名称 */
    name: string;
    /** 所有株式数 */
    numberOfShares?: number;
    /** 持株比率 (%) */
    ownershipRatio?: number;
}

/**
 * 年次の有価証券報告書。財務情報を含みます。
 * @documentType Annual (有価証券報告書) [120]
 * @japaneseLabel 有価証券報告書
 */
export interface AnnualResponse {
    metadata: CommonMetadata;
    metrics: KeyMetrics;
}

/**
 * 四半期ごとの報告書。財務情報を含みます。
 * @documentType Quarterly (四半期報告書) [140]
 * @japaneseLabel 四半期報告書
 */
export interface QuarterlyResponse {
    metadata: CommonMetadata;
    metrics: KeyMetrics;
}

/**
 * 半期ごとの報告書。財務情報を含みます。
 * @documentType SemiAnnual (半期報告書) [160]
 * @japaneseLabel 半期報告書
 */
export interface SemiAnnualResponse {
    metadata: CommonMetadata;
    metrics: KeyMetrics;
}

/**
 * 臨時報告書。財務情報を含む場合があります。
 * @documentType Extraordinary (臨時報告書) [180]
 * @japaneseLabel 臨時報告書
 */
export interface ExtraordinaryResponse {
    metadata: CommonMetadata;
    metrics: KeyMetrics;
}

/**
 * 大量保有報告書、変更報告書、訂正報告書。保有情報を含みます。
 * @documentType LargeShareholding (大量保有報告書) [340/350/360]
 * @japaneseLabel 大量保有報告書
 */
export interface LargeShareholdingResponse {
    metadata: CommonMetadata;
    info: LargeShareholdingInfo;
}

/**
 * 有価証券届出書。財務情報を含む場合があります。
 * @documentType SecuritiesRegistration (有価証券届出書) [010]
 * @japaneseLabel 有価証券届出書
 */
export interface SecuritiesRegistrationResponse {
    metadata: CommonMetadata;
    metrics: KeyMetrics;
}

/**
 * 内部統制報告書。主にメタデータのみが返されます。
 * @documentType InternalControl (内部統制報告書) [235]
 * @japaneseLabel 内部統制報告書
 */
export interface InternalControlResponse {
    metadata: CommonMetadata;
}

/**
 * 公開買付届出書または公開買付報告書。主にメタデータのみが返されます。
 * @documentType TenderOffer (公開買付届出書/報告書) [240/270]
 * @japaneseLabel 公開買付関連書類
 */
export interface TenderOfferResponse {
    metadata: CommonMetadata;
}
