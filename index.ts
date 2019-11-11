import * as types from "@vue-storefront/core/modules/cart/store/mutation-types"
import { Logger } from "@vue-storefront/core/lib/logger"
import isString from "lodash-es/isString"
import rootStore from "@vue-storefront/core/store"
import { TaskQueue } from "@vue-storefront/core/lib/sync"
import config from "config"
import SearchQuery from '@vue-storefront/core/lib/search/searchQuery'
import i18n from '@vue-storefront/i18n'
import Vue from 'vue'
import Task from '@vue-storefront/core/lib/sync/types/Task'
import * as extendTypes from './store/mutation-types'

const MAX_BYPASS_COUNT = 10
let _connectBypassCount = 0

function _getDifflogPrototype() {
  return { items: [], serverResponses: [], clientNotifications: [] }
}

function _serverDeleteItem ({ cartServerToken, cartItem }): Promise<Task> {
  cartItem = Object.assign(cartItem, { quoteId: cartServerToken })
  return TaskQueue.execute({ url: config.cart.deleteitem_endpoint, // sync the cart
    payload: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      mode: 'cors',
      body: JSON.stringify({
        cartItem: cartItem
      })
    },
    silent: true
  })
}

function _serverUpdateItem ({ cartServerToken, cartItem }): Promise<Task> {
  if (!cartItem.quoteId) {
    cartItem = Object.assign(cartItem, { quoteId: cartServerToken })
  }

  return TaskQueue.execute({ url: config.cart.updateitem_endpoint, // sync the cart
    payload: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      mode: 'cors',
      body: JSON.stringify({
        cartItem: cartItem
      })
    }
  })
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
              { forceClientState = false, dryRun = false, pullItemsFromServer = false }
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
                        forceClientState: forceClientState,
                        pullItemsFromServer: pullItemsFromServer
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
            },
            async merge ({ getters, dispatch, commit, rootGetters }, { serverItems, clientItems, dryRun = false, forceClientState = false, pullItemsFromServer = false }) {
              const diffLog = _getDifflogPrototype()
              let totalsShouldBeRefreshed = getters.isTotalsSyncRequired // when empty it means no sync has yet been executed
              let serverCartUpdateRequired = false
              let clientCartUpdateRequired = false
              let cartHasItems = false
              const clientCartAddItems = []

              /** helper to find the item to be added to the cart by sku */
              let productActionOptions = (serverItem) => {
                return new Promise(resolve => {
                  if (serverItem.product_type === 'configurable') {
                    let searchQuery = new SearchQuery()
                    searchQuery = searchQuery.applyFilter({key: 'configurable_children.sku', value: {'eq': serverItem.sku}})
                    dispatch('product/list', {query: searchQuery, start: 0, size: 1, updateState: false}, { root: true }).then((resp) => {
                      if (resp.items.length >= 1) {
                        resolve({ sku: resp.items[0].sku, childSku: serverItem.sku })
                      }
                    })
                  } else {
                    resolve({ sku: serverItem.sku })
                  }
                })
              }
              /** helper - sub method to update the item in the cart */
              const _updateClientItem = async function ({ dispatch }, event, clientItem) {
                if (typeof event.result.item_id !== 'undefined') {
                  await dispatch('updateItem', { product: { server_item_id: event.result.item_id, sku: clientItem.sku, server_cart_id: event.result.quote_id, prev_qty: clientItem.qty } }) // update the server_id reference
                  Vue.prototype.$bus.$emit('cart-after-itemchanged', { item: clientItem })
                }
              }

              /** helper - sub method to react for the server response after the sync */
              const _afterServerItemUpdated = async function ({ dispatch, commit }, event, clientItem = null) {
                Logger.debug('Cart item server sync' + event, 'cart')()
                diffLog.serverResponses.push({ 'status': event.resultCode, 'sku': clientItem.sku, 'result': event })
                if (event.resultCode !== 200) {
                  // TODO: add the strategy to configure behaviour if the product is (confirmed) out of the stock
                  if (clientItem.server_item_id) {
                    dispatch('getItem', clientItem.sku).then((cartItem) => {
                      if (cartItem) {
                        Logger.log('Restoring qty after error' + clientItem.sku + cartItem.prev_qty, 'cart')()
                        if (cartItem.prev_qty > 0) {
                          dispatch('updateItem', { product: { qty: cartItem.prev_qty } }) // update the server_id reference
                          Vue.prototype.$bus.$emit('cart-after-itemchanged', { item: cartItem })
                        } else {
                          dispatch('removeItem', { product: cartItem, removeByParentSku: false }) // update the server_id reference
                        }
                      }
                    })
                  } else {
                    Logger.warn('Removing product from cart', 'cart', clientItem)()
                    commit(types.CART_DEL_NON_CONFIRMED_ITEM, { product: clientItem })
                  }
                } else {
                  const isUserInCheckout = rootGetters['checkout/isUserInCheckout']
                  if (!isUserInCheckout) { // if user is in the checkout - this callback is just a result of server sync
                    const isThisNewItemAddedToTheCart = (!clientItem || !clientItem.server_item_id)
                    const notificationData = {
                      type: 'success',
                      message: isThisNewItemAddedToTheCart ? i18n.t('Product has been added to the cart!') : i18n.t('Product quantity has been updated!'),
                      action1: { label: i18n.t('OK') },
                      action2: null
                    }
                    if (!config.externalCheckout) { // if there is externalCheckout enabled we don't offer action to go to checkout as it can generate cart desync
                      notificationData.action2 = { label: i18n.t('Proceed to checkout'),
                        action: () => {
                          dispatch('goToCheckout')
                        }}
                    }
                    diffLog.clientNotifications.push(notificationData) // display the notification only for newly added products
                  }
                }
                if (clientItem === null) {
                  const cartItem = await dispatch('getItem', event.result.sku)
                  if (cartItem) {
                    await _updateClientItem({ dispatch }, event, cartItem)
                  }
                } else {
                  await _updateClientItem({ dispatch }, event, clientItem)
                }
              }
              for (const clientItem of clientItems) {
                cartHasItems = true
                const serverItem = serverItems.find((itm) => {
                  return itm.sku === clientItem.sku || itm.sku.indexOf(clientItem.sku + '-') === 0 /* bundle products */
                })

                if (!serverItem) {
                  Logger.warn('No server item with sku ' + clientItem.sku + ' on stock.', 'cart')()
                  diffLog.items.push({ 'party': 'server', 'sku': clientItem.sku, 'status': 'no-item' })
                  if (!dryRun) {
                    if (forceClientState || !config.cart.serverSyncCanRemoveLocalItems) {
                      const event = await _serverUpdateItem({
                        cartServerToken: getters.getCartToken,
                        cartItem: {
                          sku: clientItem.parentSku && config.cart.setConfigurableProductOptions ? clientItem.parentSku : clientItem.sku,
                          qty: clientItem.qty,
                          product_option: clientItem.product_option
                        }
                      })
                      _afterServerItemUpdated({ dispatch, commit }, event, clientItem)
                      serverCartUpdateRequired = true
                      totalsShouldBeRefreshed = true
                    } else {
                      dispatch('removeItem', {
                        product: clientItem
                      })
                    }
                  }
                } else if (serverItem.qty !== clientItem.qty) {
                  Logger.log('Wrong qty for ' + clientItem.sku, clientItem.qty, serverItem.qty)()
                  diffLog.items.push({ 'party': 'server', 'sku': clientItem.sku, 'status': 'wrong-qty', 'client-qty': clientItem.qty, 'server-qty': serverItem.qty })
                  if (!dryRun) {
                    if (forceClientState || !config.cart.serverSyncCanModifyLocalItems) {
                      const event = await _serverUpdateItem({
                        cartServerToken: getters.getCartToken,
                        cartItem: {
                          sku: clientItem.parentSku && config.cart.setConfigurableProductOptions ? clientItem.parentSku : clientItem.sku,
                          qty: clientItem.qty,
                          item_id: serverItem.item_id,
                          quoteId: serverItem.quote_id,
                          product_option: clientItem.product_option
                        }
                      })
                      _afterServerItemUpdated({ dispatch, commit }, event, clientItem)
                      totalsShouldBeRefreshed = true
                      serverCartUpdateRequired = true
                    } else {
                      await dispatch('updateItem', {
                        product: serverItem
                      })
                    }
                  }
                } else {
                  Logger.info('Server and client item with SKU ' + clientItem.sku + ' synced. Updating cart.', 'cart', 'cart')()
                  if (!dryRun) {
                    await dispatch('updateItem', { product: { sku: clientItem.sku, server_cart_id: serverItem.quote_id, server_item_id: serverItem.item_id, product_option: serverItem.product_option } })
                  }
                }
              }

              for (const serverItem of serverItems) {
                if (serverItem) {
                  const clientItem = clientItems.find((itm) => {
                    return itm.sku === serverItem.sku || serverItem.sku.indexOf(itm.sku + '-') === 0 /* bundle products */
                  })
                  if (!clientItem) {
                    Logger.info('No client item for' + serverItem.sku, 'cart')()
                    diffLog.items.push({ 'party': 'client', 'sku': serverItem.sku, 'status': 'no-item' })

                    if (!dryRun) {
                      if (forceClientState && !pullItemsFromServer) {
                        Logger.info('Removing product from cart', 'cart', serverItem)()
                        Logger.log('Removing item' + serverItem.sku + serverItem.item_id, 'cart')()
                        serverCartUpdateRequired = true
                        totalsShouldBeRefreshed = true
                        const res = await _serverDeleteItem({
                          cartServerToken: getters.getCartToken,
                          cartItem: {
                            sku: serverItem.sku,
                            item_id: serverItem.item_id,
                            quoteId: serverItem.quote_id
                          }
                        })
                        diffLog.serverResponses.push({ 'status': res.resultCode, 'sku': serverItem.sku, 'result': res })
                      } else {
                        clientCartAddItems.push(
                          new Promise(resolve => {
                            productActionOptions(serverItem).then((actionOtions) => {
                              dispatch('product/single', { options: actionOtions, assignDefaultVariant: true, setCurrentProduct: false, selectDefaultVariant: false }, { root: true }).then((product) => {
                                resolve({ product: product, serverItem: serverItem })
                              })
                            })
                          })
                        )
                      }
                    }
                  }
                }
              }
              if (clientCartAddItems.length) {
                totalsShouldBeRefreshed = true
                clientCartUpdateRequired = true
                cartHasItems = true
              }
              diffLog.items.push({ 'party': 'client', 'status': clientCartUpdateRequired ? 'update-required' : 'no-changes' })
              diffLog.items.push({ 'party': 'server', 'status': serverCartUpdateRequired ? 'update-required' : 'no-changes' })
              Promise.all(clientCartAddItems).then((items) => {
                items.map(({ product, serverItem }) => {
                  product.server_item_id = serverItem.item_id
                  product.qty = serverItem.qty
                  product.server_cart_id = serverItem.quote_id
                  if (serverItem.product_option) {
                    product.product_option = serverItem.product_option
                  }
                  dispatch('addItem', { productToAdd: product, forceServerSilence: true })
                })
              })

              if (!dryRun) {
                if (totalsShouldBeRefreshed && cartHasItems) {
                  await dispatch('syncTotals')
                }
                commit(types.CART_SET_ITEMS_HASH, getters.getCurrentCartHash) // update the cart hash
              }

              // Re-mapping server items to client items one more time.
              // Delete client items if server items were deleted - freegift or backend automatically deleted item to quote.
              await TaskQueue.execute({
                url: config.cart.pull_endpoint, // sync the cart
                payload: {
                  method: "GET",
                  headers: { "Content-Type": "application/json" },
                  mode: "cors"
                },
                silent: true
              }).then(async task => {
                if (task.resultCode === 200) {
                  let serverItemsAfterPulled = task.result
                  for (const clientItem of clientItems) {
                    const serverItemAfterPulled = serverItemsAfterPulled.find((itm) => {
                      return itm.sku === clientItem.sku || itm.sku.indexOf(clientItem.sku + '-') === 0 /* bundle products */
                    })

                    if (!serverItemAfterPulled) {
                      dispatch('removeItem', {
                        product: clientItem
                      })
                    }
                  }
              }})

              Vue.prototype.$bus.$emit('servercart-after-diff', { diffLog: diffLog, serverItems: serverItems, clientItems: clientItems, dryRun: dryRun, event: event }) // send the difflog
              Logger.info('Client/Server cart synchronised ', 'cart', diffLog)()
              return diffLog
            },
            /** Force sync cart items from server to client with pullItemsFromServer */
            async forceSync ({ getters, rootGetters, commit, dispatch }, { forceClientState = true, dryRun = false, pullItemsFromServer = true }) { // force pull current cart FROM the server
              commit(extendTypes.CART_SET_FORCESYNC)
              return dispatch('sync', { forceClientState, dryRun, pullItemsFromServer})
            },
          },
          mutations: {
            [extendTypes.CART_SET_FORCESYNC] (state) {
              state.cartServerLastSyncDate = 0
            },
          }
        }
      }
    ]
  }
}
