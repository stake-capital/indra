import React from "react";
import PropTypes from "prop-types";
import classNames from "classnames";
import { withStyles } from "@material-ui/core/styles";
import CssBaseline from "@material-ui/core/CssBaseline";
import Drawer from "@material-ui/core/Drawer";
import AppBar from "@material-ui/core/AppBar";
import Toolbar from "@material-ui/core/Toolbar";
import List from "@material-ui/core/List";
import Typography from "@material-ui/core/Typography";
import Divider from "@material-ui/core/Divider";
import IconButton from "@material-ui/core/IconButton";
//import Badge from "@material-ui/core/Badge";
import MenuIcon from "@material-ui/icons/Menu";
import ChevronLeftIcon from "@material-ui/icons/ChevronLeft";
import ChevronRightIcon from "@material-ui/icons/ChevronRight";
//import NotificationsIcon from "@material-ui/icons/Notifications";
import { mainListItems } from "./listItems";
import SimpleTable from "./SimpleTable";
import Card from "@material-ui/core/Card";
import CardActions from "@material-ui/core/CardActions";
import CardContent from "@material-ui/core/CardContent";
import Button from "@material-ui/core/Button";
const ChannelManagerAbi = require("../abi/ChannelManager.json");
const TokenAbi = require("../abi/Token.json");

const drawerWidth = 240;

const styles = theme => ({
  root: {
    display: "flex"
  },
  toolbar: {
    paddingRight: 24 // keep right padding when drawer closed
  },
  toolbarIcon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    padding: "0 8px",
    ...theme.mixins.toolbar
  },
  appBar: {
    zIndex: theme.zIndex.drawer + 1,
    transition: theme.transitions.create(["width", "margin"], {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.leavingScreen
    })
  },
  appBarShift: {
    marginLeft: drawerWidth,
    width: `calc(100% - ${drawerWidth}px)`,
    transition: theme.transitions.create(["width", "margin"], {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.enteringScreen
    })
  },
  menuButton: {
    marginLeft: 12,
    marginRight: 36
  },
  menuButtonHidden: {
    display: "none"
  },
  drawerPaper: {
    position: "relative",
    whiteSpace: "nowrap",
    width: drawerWidth,
    transition: theme.transitions.create("width", {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.enteringScreen
    })
  },
  drawerPaperClose: {
    overflowX: "hidden",
    transition: theme.transitions.create("width", {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.leavingScreen
    }),
    width: theme.spacing.unit * 7,
    [theme.breakpoints.up("sm")]: {
      width: theme.spacing.unit * 9
    }
  },
  appBarSpacer: theme.mixins.toolbar,
  content: {
    flexGrow: 1,
    padding: theme.spacing.unit * 3,
    height: "100vh",
    overflow: "auto"
  },
  chartContainer: {},
  tableContainer: {
    height: 320
  },
  h5: {
    marginBottom: theme.spacing.unit * 2
  },
  card: {
    minWidth: 275
  },
  title: {
    fontSize: 14
  },
  pos: {
    marginBottom: 12
  }
});

const ContractInfoCard = props => {
  const { classes, wei, token, loading, handleRefresh, contractAddress } = props;
  return (
    <Card className={classes.card}>
      <CardContent>
        {loading ? (
          <Typography variant="h5" component="h2">
            Loading...
          </Typography>
        ) : (
          <>
            <Typography className={classes.pos} color="textSecondary">
              <a href={`https://rinkeby.etherscan.io/address/${contractAddress}`} target="_blank" rel="noopener noreferrer">{contractAddress}</a>
            </Typography>
            <Typography variant="h5" component="h2">
              {parseFloat(wei.formatted).toFixed(2)}... ETH ({wei.raw} Wei)
            </Typography>
            <Typography variant="h5" component="h2">
              ${parseFloat(token.formatted).toFixed(2)}... DAI ({token.raw} Dei)
            </Typography>
          </>
        )}
      </CardContent>
      <CardActions>
        <Button size="small" onClick={handleRefresh}>
          Refresh
        </Button>
      </CardActions>
    </Card>
  );
};

const ContractInfoCardStyled = withStyles(styles)(ContractInfoCard);

class Dashboard extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      hubUrl: this.props.hubUrl,
      open: false,
      channelManager: {
        address: '0x',
        wei: {
          raw: 0,
          formatted: 0
        },
        token: {
          raw: 0,
          formatted: 0
        },
      },
      hubWallet: {
        address: '0x',
        wei: {
          raw: 0,
          formatted: 0
        },
        token: {
          raw: 0,
          formatted: 0
        },
      },
      loadingWallet: false,
      loadingContract: false
    };
  }

  async componentDidMount() {
    await this.getHubConfig();
    await this.getContractInfo();
    await this.getWalletInfo(this.state.hubWallet.address);
  }

  async getHubConfig() {
    const config = await (await fetch(`${this.state.hubUrl}/config`)).json();
    console.log(`Got hub config: ${JSON.stringify(config,null,2)}`);
    this.setState(state => {
      state.tokenAddress = config.tokenAddress.toLowerCase()
      state.channelManager.address = config.channelManagerAddress.toLowerCase()
      state.hubWallet.address = config.hubWalletAddress.toLowerCase()
      return state
    });
  }

  getWalletInfo = async (address) => {
    const { web3 } = this.props;
    this.setState({
      loadingWallet: true
    });
    const wei = await web3.eth.getBalance(address)
    console.log("wallet wei: ", wei);
    const tokenContract = new web3.eth.Contract(TokenAbi.abi, this.state.tokenAddress);
    const token = (await tokenContract.methods.balanceOf(address).call())[0]
    console.log("wallet token: ", token)
    this.setState(state => {
      state.hubWallet.wei.raw = wei
      state.hubWallet.wei.formatted = web3.utils.fromWei(wei)
      state.hubWallet.token.raw = token
      state.hubWallet.token.formatted = web3.utils.fromWei(token)
      state.loadingWallet = false
      return state
    });
  }

  getContractInfo = async () => {
    const { web3 } = this.props;
    this.setState({
      loadingContract: true
    });
    console.log("Investigating contract at:", this.state.channelManager.address);
    const cm = new web3.eth.Contract(ChannelManagerAbi.abi, this.state.channelManager.address);
    const wei = await cm.methods.getHubReserveWei().call();
    console.log("contract wei: ", wei);
    const token = await cm.methods.getHubReserveTokens().call()
    console.log("contract token: ", token);
    this.setState(state => {
      state.channelManager.wei.raw = wei
      state.channelManager.wei.formatted = web3.utils.fromWei(wei)
      state.channelManager.token.raw = token
      state.channelManager.token.formatted = web3.utils.fromWei(token)
      state.loadingContract = false
      return state
    });
  };

  handleDrawerOpen = () => {
    this.setState({ open: true });
  };

  handleDrawerClose = () => {
    this.setState({ open: false });
  };

  toggleDrawer = () => {
    this.setState({ open: !this.state.open });
  }

  render() {
    const { classes } = this.props;
    const { loadingWallet, loadingContract, open } = this.state;

    return (
      <div className={classes.root}>
        <CssBaseline />
        <AppBar position="absolute" className={classNames(classes.appBar, this.state.open && classes.appBarShift)}>
          <Toolbar disableGutters={!this.state.open} className={classes.toolbar}>
            <IconButton
              color="inherit"
              aria-label="Open drawer"
              onClick={this.handleDrawerOpen}
              className={classNames(classes.menuButton, this.state.open && classes.menuButtonHidden)}
            >
              <MenuIcon />
            </IconButton>
            <Typography component="h1" variant="h6" color="inherit" noWrap className={classes.title}>
              Dashboard
            </Typography>
          </Toolbar>
        </AppBar>
        <Drawer
          variant="permanent"
          classes={{
            paper: classNames(classes.drawerPaper, !this.state.open && classes.drawerPaperClose)
          }}
          open={this.state.open}
        >
          <div className={classes.toolbarIcon}>
            <IconButton onClick={this.toggleDrawer}>
              {open ? <ChevronLeftIcon /> : <ChevronRightIcon />}
            </IconButton>
          </div>
          <Divider />
          <List>{mainListItems}</List>
        </Drawer>
        <main className={classes.content}>
          <Typography variant="h4" gutterBottom component="h2">
            Hub Wallet Reserves
          </Typography>
          <Typography component="div" className={classes.chartContainer} />
          <ContractInfoCardStyled
            wei={this.state.hubWallet.wei}
            token={this.state.hubWallet.token}
            handleRefresh={() => this.getWalletInfo(this.state.hubWallet.address)}
            loading={loadingWallet}
            contractAddress={this.state.hubWallet.address}
          />
          <div className={classes.appBarSpacer} />
          <Typography variant="h4" gutterBottom component="h2">
            Contract Reserves
          </Typography>
          <Typography component="div" className={classes.chartContainer} />
          <ContractInfoCardStyled
            wei={this.state.channelManager.wei}
            token={this.state.channelManager.token}
            handleRefresh={this.getContractInfo}
            loading={loadingContract}
            contractAddress={this.state.channelManager.address}
          />
          <div className={classes.appBarSpacer} />
          <Typography variant="h4" gutterBottom component="h2">
            Channels
          </Typography>
          <div className={classes.tableContainer}>
            <SimpleTable />
          </div>
        </main>
      </div>
    );
  }
}

Dashboard.propTypes = {
  classes: PropTypes.object.isRequired
};

export default withStyles(styles)(Dashboard);