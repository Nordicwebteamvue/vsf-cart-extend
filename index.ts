import * as types from "@vue-storefront/core/modules/cart/store/mutation-types"
import { Logger } from "@vue-storefront/core/lib/logger"
import isString from "lodash-es/isString"
import rootStore from "@vue-storefront/core/store"
import { TaskQueue } from "@vue-storefront/core/lib/sync"
import config from "config"

const MAX_BYPASS_COUNT = 10
let _connectBypassCount = 0

function _getDifflogPrototype() {
  return { items: [], serverResponses: [], clientNotifications: [] }
}

export const cartExtend = {
  key: "cart",
  store: {
    modules: [
      {
        key: "cart",
        module: {
          actions: {
            servercartAfterTotals(context, event) {
              if (event.resultCode === 200) {
                const totalsObj = event.result.totals
                  ? event.result.totals
                  : event.result
                Logger.info("Overriding server totals. ", "cart", totalsObj)()
                let itemsAfterTotal = {}
                let platformTotalSegments = totalsObj.total_segments
                for (let item of totalsObj.items) {
                  if (item.options && isString(item.options))
                    item.options = JSON.parse(item.options)
                  itemsAfterTotal[item.item_id] = item
                  rootStore.dispatch(
                    "cart/updateItem",
                    {
                      product: {
                        server_item_id: item.item_id,
                        totals: item,
                        qty: item.qty
                      }
                    },
                    { root: true }
                  ) // update the server_id reference
                }
                for (let segment of totalsObj.total_segments) {
                  if (segment.code == "shipping") {
                    segment.value = totalsObj.shipping_incl_tax
                  }
                }
                rootStore.commit(types.SN_CART + "/" + types.CART_UPD_TOTALS, {
                  itemsAfterTotal: itemsAfterTotal,
                  totals: totalsObj,
                  platformTotalSegments: platformTotalSegments
                })
              } else {
                Logger.error(event.result, "cart")()
              }
            },
            async sync(
              { getters, rootGetters, commit, dispatch },
              { forceClientState = false, dryRun = false }
            ) {
              // pull current cart FROM the server
              const isUserInCheckout = rootGetters["checkout/isUserInCheckout"]
              let diffLog = _getDifflogPrototype()
              if (isUserInCheckout) forceClientState = true // never surprise the user in checkout - #
              if (getters.isCartSyncEnabled && getters.isCartConnected) {
                if (getters.isSyncRequired) {
                  // cart hash empty or not changed
                  /** @todo: move this call to data resolver; shouldn't be a part of public API no more */
                  commit(types.CART_SET_SYNC)
                  const task = await TaskQueue.execute({
                    url: config.cart.pull_endpoint, // sync the cart
                    payload: {
                      method: "GET",
                      headers: { "Content-Type": "application/json" },
                      mode: "cors"
                    },
                    silent: true
                  }).then(async task => {
                    if (task.resultCode === 200) {
                      diffLog = await dispatch("merge", {
                        serverItems: task.result,
                        clientItems: getters.getCartItems,
                        dryRun: dryRun,
                        forceClientState: forceClientState
                      })
                    } else {
                      Logger.error(task.result, "cart") // override with guest cart()
                      if (_connectBypassCount < MAX_BYPASS_COUNT) {
                        Logger.log(
                          "Bypassing with guest cart" + _connectBypassCount,
                          "cart"
                        )()
                        _connectBypassCount = _connectBypassCount + 1
                        await dispatch("connect", { guestCart: true })
                        if (
                          !task.result.includes("No such entity with cartId")
                        ) {
                          Logger.error(task.result, "cart")()
                        }
                      }
                    }
                  })
                  return diffLog
                } else {
                  return diffLog
                }
              } else {
                return diffLog
              }
            }
          }
        }
      }
    ]
  }
}
