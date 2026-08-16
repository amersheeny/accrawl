package app.accrawl.accrawl_companion

import android.app.Application

/**
 * Exists to make this installation ready to receive a wake before one can arrive.
 *
 * The app is built against no push project: it asks the deployment it pairs with which one to use, so a
 * single published build works against any deployment. The cost of that is losing the build-time
 * initialisation a project file would have provided, and a wake delivered to a process with no push
 * client is simply dropped — the phone would look offline for exactly the crawl that was waiting on it.
 *
 * So the configuration learned at pairing is applied here, at process start, before anything can be
 * delivered. An installation that has not paired yet, or is paired to a deployment that sends no
 * wake-ups, has nothing to apply and does nothing.
 */
class CompanionApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        PushRegistration.initializeFromCache(this)
    }
}
